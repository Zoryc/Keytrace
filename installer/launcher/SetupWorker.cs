using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace MidiConverterLauncher
{
    internal enum SetupOutcome
    {
        None,
        Success,
        Failed,
        Cancelled
    }

    internal sealed class SetupException : Exception
    {
        public SetupException(string message) : base(message) { }
    }

    /// <summary>
    /// Runs the three setup steps on a background thread:
    ///   1. uv python install 3.13                       (0 - 2 % of the bar)
    ///   2. uv venv {app}\runtime --python 3.13          (2 - 3 %)
    ///   3. runtime python app\scripts\setup_runtime.py  (3 - 100 %, from its @@PROGRESS lines)
    /// Events are raised on the worker thread; the window marshals them with BeginInvoke.
    /// </summary>
    internal sealed class SetupWorker
    {
        public event Action<string> StatusChanged;
        public event Action<double> ProgressChanged;
        public event Action<string> LogLine;
        public event Action<SetupOutcome, string> Finished;

        private const double PythonDone = 0.02;
        private const double VenvDone = 0.03;
        private const string PythonVersion = "3.13";

        private readonly AppPaths paths;
        private readonly bool withAria;
        private volatile bool cancelRequested;
        private readonly object progressSync = new object();
        private double lastProgress;
        private JobObject job;
        private SetupLogFile logFile;

        private sealed class Protocol
        {
            public volatile string Done;
            public volatile string Error;
        }

        public SetupWorker(AppPaths paths, bool withAria)
        {
            this.paths = paths;
            this.withAria = withAria;
        }

        public string LogFilePath
        {
            get { SetupLogFile f = logFile; return f == null ? paths.SetupLog : f.FilePath; }
        }

        public void Start()
        {
            Thread t = new Thread(Run);
            t.IsBackground = true;
            t.Name = "MIDI Converter setup";
            t.Start();
        }

        /// <summary>Stop now: kills the running step with all its child processes.</summary>
        public void Cancel()
        {
            cancelRequested = true;
            JobObject j = job;
            if (j != null) j.Terminate();
        }

        private void Run()
        {
            SetupOutcome outcome = SetupOutcome.Failed;
            string message = null;
            job = new JobObject();
            logFile = SetupLogFile.Open(paths.SetupLog);
            try
            {
                Log("==== " + Program.ProductName + " setup " + Application.ProductVersion + ", " +
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + " ====");
                Log("Install folder: " + paths.Root);
                Log("Components: " + (withAria ? "standard + Aria-AMT" : "standard"));
                string uvCache = paths.UvCache;
                Log("uv cache: " + uvCache);
                if (uvCache.Length > AppPaths.MaxUvCacheLength + 15)
                    Log("Note: the uv cache path is long (" + uvCache.Length + " characters). Building packages from " +
                        "source can fail unless Windows long path support is enabled.");
                Log("Log file: " + logFile.FilePath);

                paths.SaveWithAria(withAria);
                // The marker is rewritten by setup_runtime.py on success: until then the app goes through the setup.
                DeleteFile(paths.ReadyMarker);

                if (!File.Exists(paths.Uv))
                    throw new SetupException("A file of MIDI Converter is missing (tools\\uv.exe). Please reinstall MIDI Converter.");
                if (!File.Exists(paths.SetupScript))
                    throw new SetupException("A file of MIDI Converter is missing (app\\scripts\\setup_runtime.py). Please reinstall MIDI Converter.");

                SetStatus("Downloading Python");
                SetProgress(0.0);
                int code = RunStep(paths.Uv, new string[] { "python", "install", PythonVersion, "--no-bin", "--no-registry" }, null);
                if (code != 0)
                    throw new SetupException("Python could not be downloaded. Check your internet connection and try again.");
                SetProgress(PythonDone);

                SetStatus("Preparing the Python environment");
                code = RunStep(paths.Uv, new string[] { "venv", paths.Runtime, "--python", PythonVersion, "--allow-existing", "--no-project" }, null);
                if (code != 0 || !File.Exists(paths.RuntimePython))
                    throw new SetupException("The Python environment for MIDI Converter could not be created.");
                SetProgress(VenvDone);

                SetStatus("Installing components");
                List<string> args = new List<string>();
                args.Add(paths.SetupScript);
                args.Add("--uv");
                args.Add(paths.Uv);
                if (withAria) args.Add("--with-aria");
                Protocol proto = new Protocol();
                code = RunStep(paths.RuntimePython, args.ToArray(), proto);
                if (proto.Error != null)
                    throw new SetupException(proto.Error);
                if (code != 0)
                    throw new SetupException("The components could not be installed (exit code " + code +
                                             "). Check your internet connection and try again.");
                if (!File.Exists(paths.ReadyMarker))
                    throw new SetupException("The installation could not be verified. Please try again.");

                SetProgress(1.0);
                outcome = SetupOutcome.Success;
                message = proto.Done ?? "MIDI Converter is ready.";
            }
            catch (OperationCanceledException)
            {
                outcome = SetupOutcome.Cancelled;
                message = "Setup was cancelled.";
            }
            catch (SetupException e)
            {
                outcome = SetupOutcome.Failed;
                message = e.Message;
            }
            catch (Exception e)
            {
                outcome = SetupOutcome.Failed;
                message = "Unexpected error: " + e.Message;
                Log(e.ToString());
            }
            finally
            {
                job.Dispose(); // kills anything still running in the job
            }

            // setup_runtime.py removes the download cache itself; this also covers cancelled and failed runs.
            if (!paths.UsingCustomUvCache)
            {
                if (outcome == SetupOutcome.Cancelled) SetStatus("Cancelling: removing temporary files");
                DeleteDirectory(paths.DefaultUvCache);
                string cache = paths.UvCache; // the %TEMP% replacement for a long {app}\.uv-cache
                if (!string.Equals(cache, paths.DefaultUvCache, StringComparison.OrdinalIgnoreCase)) DeleteDirectory(cache);
            }

            Log("==== Result: " + outcome + ": " + message + " ====");
            Log("");
            logFile.Dispose();

            Action<SetupOutcome, string> finished = Finished;
            if (finished != null) finished(outcome, message);
        }

        private int RunStep(string exe, string[] args, Protocol proto)
        {
            if (cancelRequested) throw new OperationCanceledException();
            string argLine = CommandLine.Join(args);
            Log("> " + Path.GetFileName(exe) + " " + argLine);

            ProcessStartInfo psi = new ProcessStartInfo(exe, argLine);
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WorkingDirectory = paths.Root;
            psi.RedirectStandardInput = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = new UTF8Encoding(false);
            psi.StandardErrorEncoding = new UTF8Encoding(false);
            Env.PrepareForSetup(psi.EnvironmentVariables, paths);

            using (Process p = new Process())
            {
                p.StartInfo = psi;
                try
                {
                    p.Start();
                }
                catch (Exception e)
                {
                    throw new SetupException("Could not start " + Path.GetFileName(exe) + ": " + e.Message);
                }
                bool inJob = job.Assign(p);
                if (!inJob) Log("(note: could not put the process in a job object; cancel will use taskkill)");
                try { p.StandardInput.Close(); } catch (Exception) { }

                Thread outReader = StartReader(p.StandardOutput, proto);
                Thread errReader = StartReader(p.StandardError, null);
                bool killed = false;
                while (!p.WaitForExit(200))
                {
                    if (cancelRequested && !killed)
                    {
                        killed = true;
                        if (inJob) job.Terminate();
                        else JobObject.KillTree(p.Id);
                    }
                }
                outReader.Join(5000);
                errReader.Join(5000);
                int code = p.ExitCode;
                Log("  (exit code " + code + ")");
                if (cancelRequested) throw new OperationCanceledException();
                return code;
            }
        }

        private Thread StartReader(StreamReader reader, Protocol proto)
        {
            Thread t = new Thread(delegate()
            {
                try
                {
                    string line;
                    while ((line = reader.ReadLine()) != null) HandleLine(line, proto);
                }
                catch (Exception) { }
            });
            t.IsBackground = true;
            t.Start();
            return t;
        }

        /// <summary>setup_runtime.py's stdout protocol: @@STATUS, @@PROGRESS, @@DONE, @@ERROR; other lines are details.</summary>
        private void HandleLine(string line, Protocol proto)
        {
            if (proto != null && line.StartsWith("@@", StringComparison.Ordinal))
            {
                int space = line.IndexOf(' ');
                string kind = space < 0 ? line : line.Substring(0, space);
                string text = space < 0 ? "" : line.Substring(space + 1).Trim();
                switch (kind)
                {
                    case "@@STATUS":
                        Log("[status] " + text);
                        if (text.Length > 0) SetStatus(text);
                        return;
                    case "@@PROGRESS":
                        double v;
                        if (double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out v))
                            SetProgress(VenvDone + (1.0 - VenvDone) * Math.Max(0.0, Math.Min(1.0, v)));
                        return;
                    case "@@DONE":
                        Log("[done] " + text);
                        proto.Done = text.Length > 0 ? text : null;
                        return;
                    case "@@ERROR":
                        Log("[error] " + text);
                        proto.Error = text.Length > 0 ? text : "The components could not be installed.";
                        return;
                }
            }
            Log(line);
        }

        private void SetStatus(string text)
        {
            Action<string> h = StatusChanged;
            if (h != null) h(text);
        }

        private void SetProgress(double value)
        {
            double v;
            lock (progressSync)
            {
                if (value < lastProgress) return; // never move backwards
                lastProgress = value;
                v = value;
            }
            Action<double> h = ProgressChanged;
            if (h != null) h(v);
        }

        private void Log(string line)
        {
            SetupLogFile f = logFile;
            if (f != null) f.WriteLine(line);
            Action<string> h = LogLine;
            if (h != null) h(line);
        }

        private void DeleteFile(string path)
        {
            try
            {
                if (File.Exists(path)) File.Delete(path);
            }
            catch (Exception e)
            {
                Log("Could not remove " + path + ": " + e.Message);
            }
        }

        private void DeleteDirectory(string dir)
        {
            if (!Directory.Exists(dir)) return;
            try
            {
                Directory.Delete(dir, true);
                return;
            }
            catch (Exception) { }
            // Fallback: rd copes with read-only files, junctions and very long paths.
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "cmd.exe"),
                    "/c rd /s /q \"\\\\?\\" + Path.GetFullPath(dir) + "\"");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                using (Process p = Process.Start(psi)) { p.WaitForExit(120000); }
            }
            catch (Exception) { }
            if (Directory.Exists(dir)) Log("Could not remove " + dir);
        }
    }

    /// <summary>{app}\setup.log (appended; restarted when it grows past 5 MB). Falls back to %TEMP% if the folder is read-only.</summary>
    internal sealed class SetupLogFile : IDisposable
    {
        private const long MaxSize = 5L * 1024 * 1024;
        private readonly object sync = new object();
        private StreamWriter writer;
        public string FilePath;

        public static SetupLogFile Open(string preferred)
        {
            SetupLogFile log = new SetupLogFile();
            string[] candidates = { preferred, Path.Combine(Path.GetTempPath(), "MIDI Converter setup.log") };
            foreach (string path in candidates)
            {
                try
                {
                    FileInfo fi = new FileInfo(path);
                    FileMode mode = fi.Exists && fi.Length > MaxSize ? FileMode.Create : FileMode.Append;
                    FileStream fs = new FileStream(path, mode, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
                    log.writer = new StreamWriter(fs, new UTF8Encoding(false));
                    log.writer.AutoFlush = true;
                    log.FilePath = path;
                    break;
                }
                catch (Exception) { }
            }
            if (log.FilePath == null) log.FilePath = preferred;
            return log;
        }

        public void WriteLine(string line)
        {
            lock (sync)
            {
                if (writer == null) return;
                try
                {
                    writer.WriteLine(line.Length == 0 ? "" : DateTime.Now.ToString("HH:mm:ss", CultureInfo.InvariantCulture) + "  " + line);
                }
                catch (Exception) { }
            }
        }

        public void Dispose()
        {
            lock (sync)
            {
                if (writer != null)
                {
                    try { writer.Dispose(); } catch (Exception) { }
                    writer = null;
                }
            }
        }
    }
}

// MIDI Converter launcher ("MIDI Converter.exe").
//
//   MIDI Converter.exe [files...]                   start the app (runtime\Scripts\pythonw.exe -m midiconv),
//                                                   or finish the setup first if the runtime is not ready
//   MIDI Converter.exe --setup [--with-aria] [--quiet] [--unattended]
//                                                   download Python, PyTorch and the packages;
//                                                   exit 0 = success, 1 = error, 2 = cancelled
//                                                   --quiet: close by itself on success
//                                                   --unattended: also close by itself on failure
//                                                   (silent installs: nobody is there to click Close)
//
//   --elevated-repair (private, with --setup) marks the elevated copy that a repair of an all-users install
//   starts: its non-elevated parent holds the setup mutex for it while it waits, so it skips that check.
//
// C# 5 / .NET Framework 4.x, built by installer/build.ps1 with csc.exe.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

// Run with .NET Framework 4.6.2+ defaults (e.g. paths longer than 260 characters) instead of the
// 4.0 compatibility behaviour an assembly without this attribute gets.
[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.6.2", FrameworkDisplayName = ".NET Framework 4.6.2")]

namespace MidiConverterLauncher
{
    internal static class Program
    {
        public const string ProductName = "MIDI Converter";
        public const string AppUserModelId = "MIDIConverter.Desktop";
        public const string SetupMutexName = "Local\\MIDIConverter.Setup";
        public const string SetupWindowTitle = "MIDI Converter Setup";
        private const string ElevatedRepairFlag = "--elevated-repair";

        public const int ExitSuccess = 0;
        public const int ExitError = 1;
        public const int ExitCancelled = 2;

        [STAThread]
        private static int Main(string[] args)
        {
            AppPaths paths = AppPaths.FromExecutable();

            bool setup = false;
            bool withAria = false;
            bool quiet = false;
            bool unattended = false;
            bool elevatedRepair = false;
            List<string> passThrough = new List<string>();
            foreach (string a in args)
            {
                if (IsFlag(a, "--setup")) setup = true;
                else passThrough.Add(a);
            }
            if (setup)
            {
                List<string> unknown = new List<string>();
                foreach (string a in passThrough)
                {
                    if (IsFlag(a, "--with-aria")) withAria = true;
                    else if (IsFlag(a, "--quiet")) quiet = true;
                    else if (IsFlag(a, "--unattended")) unattended = quiet = true;
                    else if (IsFlag(a, ElevatedRepairFlag)) elevatedRepair = true;
                    else unknown.Add(a);
                }
                if (unknown.Count > 0)
                {
                    InitUi();
                    MessageBox.Show("Unknown option: " + unknown[0] + "\n\nUsage: \"MIDI Converter.exe\" --setup [--with-aria] [--quiet] [--unattended]",
                        SetupWindowTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return ExitError;
                }
                return RunSetup(paths, withAria, quiet, unattended, SetupMode.Explicit, null, elevatedRepair);
            }

            List<string> appArgs = ResolvePaths(passThrough);
            if (paths.RuntimeReady)
                return LaunchApp(paths, appArgs, null) ? ExitSuccess : ExitError;

            // The runtime is missing or incomplete: finish (repair) the setup, then start the app.
            return RunSetup(paths, paths.ReadSavedWithAria(), false, false, SetupMode.Repair, appArgs, false);
        }

        private static bool IsFlag(string arg, string flag)
        {
            return string.Equals(arg, flag, StringComparison.OrdinalIgnoreCase)
                || string.Equals(arg, "/" + flag.Substring(2), StringComparison.OrdinalIgnoreCase);
        }

        private static void InitUi()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
        }

        /// <param name="elevatedRepair">This is the elevated copy started by <see cref="RunElevatedRepair"/>: its parent
        /// holds the setup mutex on its behalf, so a mutex that is already owned does not mean "another setup is running".</param>
        private static int RunSetup(AppPaths paths, bool withAria, bool quiet, bool unattended, SetupMode mode, List<string> appArgs,
                                    bool elevatedRepair)
        {
            InitUi();
            // One setup at a time. Ownership counts, not whether the mutex already exists: the parent of an elevated
            // repair keeps its handle open while the elevated copy runs.
            Mutex mutex = OpenSetupMutex();
            bool owned = mutex != null && TryAcquire(mutex);
            try
            {
                if (!owned && !elevatedRepair)
                {
                    // Another setup window is already running: bring it to the front.
                    Native.ActivateWindowByTitle(SetupWindowTitle);
                    return mode == SetupMode.Repair ? ExitSuccess : ExitError;
                }
                if (mode == SetupMode.Repair && !paths.CanWriteInstallDir())
                {
                    // Keep holding the mutex while the elevated copy runs: a second start of the app then only
                    // brings the setup window to the front instead of asking for elevation again.
                    return RunElevatedRepair(paths, withAria, appArgs);
                }
                Native.SetAppUserModelId(AppUserModelId);
                Application.ThreadException += delegate(object s, ThreadExceptionEventArgs e)
                {
                    MessageBox.Show("Unexpected error:\n\n" + e.Exception, SetupWindowTitle,
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                };
                using (SetupForm form = new SetupForm(paths, withAria, quiet, unattended, mode, appArgs))
                {
                    Application.Run(form);
                    switch (form.Outcome)
                    {
                        case SetupOutcome.Success: return ExitSuccess;
                        case SetupOutcome.Cancelled: return ExitCancelled;
                        default: return ExitError;
                    }
                }
            }
            finally
            {
                if (owned)
                {
                    try { mutex.ReleaseMutex(); } catch (ApplicationException) { }
                }
                if (mutex != null) mutex.Dispose();
            }
        }

        /// <summary>The setup mutex, or null when it cannot be opened: then an elevated setup created it (all-users
        /// install) and is running, since a non-elevated process may not open an elevated process's mutex.</summary>
        private static Mutex OpenSetupMutex()
        {
            try
            {
                return new Mutex(false, SetupMutexName);
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static bool TryAcquire(Mutex mutex)
        {
            try
            {
                return mutex.WaitOne(0);
            }
            catch (AbandonedMutexException)
            {
                return true; // a setup that was killed left it behind: it is ours now
            }
        }

        /// <summary>The app is installed for all users (Program Files): run the setup elevated, then start the app as the user.
        /// The caller holds the setup mutex until this returns; the elevated copy gets --elevated-repair so that it does not
        /// mistake that for another setup.</summary>
        private static int RunElevatedRepair(AppPaths paths, bool withAria, List<string> appArgs)
        {
            DialogResult answer = MessageBox.Show(
                "MIDI Converter needs to finish installing its components (about 3 GB).\n\n" +
                "It is installed for all users, so Windows will ask for administrator permission.",
                SetupWindowTitle, MessageBoxButtons.OKCancel, MessageBoxIcon.Information);
            if (answer != DialogResult.OK) return ExitCancelled;
            ProcessStartInfo psi = new ProcessStartInfo(paths.LauncherExe,
                "--setup --quiet" + (withAria ? " --with-aria" : "") + " " + ElevatedRepairFlag);
            psi.UseShellExecute = true;
            psi.Verb = "runas";
            psi.WorkingDirectory = paths.Root;
            int code;
            try
            {
                using (Process p = Process.Start(psi))
                {
                    p.WaitForExit();
                    code = p.ExitCode;
                }
            }
            catch (Win32Exception e)
            {
                if (e.NativeErrorCode == 1223) return ExitCancelled; // the user declined the UAC prompt
                MessageBox.Show("The setup could not be started:\n\n" + e.Message, SetupWindowTitle,
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return ExitError;
            }
            if (code == ExitCancelled) return ExitCancelled;
            if (code != ExitSuccess)
            {
                MessageBox.Show(
                    "MIDI Converter could not finish installing its components" +
                    (code == ExitError ? "." : " (exit code " + code + ").") + "\n\n" +
                    "The details are in the setup log:\n" + paths.SetupLog + "\n\n" +
                    "Open MIDI Converter again to retry.",
                    SetupWindowTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return ExitError;
            }
            return LaunchApp(paths, appArgs, null) ? ExitSuccess : ExitError;
        }

        /// <summary>Relative file arguments become absolute: the app runs with {app}\app as its working directory.</summary>
        private static List<string> ResolvePaths(List<string> args)
        {
            List<string> result = new List<string>();
            foreach (string a in args)
            {
                string value = a;
                if (a.Length > 0 && a[0] != '-')
                {
                    try
                    {
                        if (File.Exists(a) || Directory.Exists(a)) value = Path.GetFullPath(a);
                    }
                    catch (Exception) { }
                }
                result.Add(value);
            }
            return result;
        }

        /// <summary>Start runtime\Scripts\pythonw.exe -m midiconv [files...]; shows an error box and returns false on failure.</summary>
        public static bool LaunchApp(AppPaths paths, IList<string> appArgs, IWin32Window owner)
        {
            StringBuilder cmd = new StringBuilder("-m midiconv");
            if (appArgs != null)
            {
                foreach (string a in appArgs)
                {
                    cmd.Append(' ');
                    cmd.Append(CommandLine.Quote(a));
                }
            }
            ProcessStartInfo psi = new ProcessStartInfo(paths.PythonW, cmd.ToString());
            psi.WorkingDirectory = paths.AppDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            Env.PrepareForApp(psi.EnvironmentVariables);
            try
            {
                using (Process.Start(psi)) { }
                return true;
            }
            catch (Exception e)
            {
                InitUiSafe();
                string msg = "MIDI Converter could not be started:\n\n" + e.Message +
                             "\n\nIf this keeps happening, reinstall MIDI Converter.";
                if (owner != null)
                    MessageBox.Show(owner, msg, ProductName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                else
                    MessageBox.Show(msg, ProductName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }
        }

        private static bool uiInitialized;

        private static void InitUiSafe()
        {
            if (uiInitialized) return;
            uiInitialized = true;
            try { Application.EnableVisualStyles(); } catch (Exception) { }
        }
    }

    internal enum SetupMode
    {
        Explicit, // --setup (from the installer, or by hand)
        Repair    // normal start with a missing / incomplete runtime
    }

    /// <summary>The installed layout, relative to the launcher's own folder.</summary>
    internal sealed class AppPaths
    {
        public string Root;
        public string LauncherExe;
        public string Uv;
        public string AppDir;
        public string SetupScript;
        public string Runtime;
        public string RuntimePython;
        public string PythonW;
        public string ReadyMarker;
        public string PythonInstallDir;
        public string DefaultUvCache;
        public string SetupLog;
        public string OptionsFile;
        public string IconFile;

        public static AppPaths FromExecutable()
        {
            AppPaths p = new AppPaths();
            p.LauncherExe = Path.GetFullPath(Application.ExecutablePath);
            p.Root = Path.GetDirectoryName(p.LauncherExe);
            p.Uv = Path.Combine(p.Root, "tools\\uv.exe");
            p.AppDir = Path.Combine(p.Root, "app");
            p.SetupScript = Path.Combine(p.AppDir, "scripts\\setup_runtime.py");
            p.Runtime = Path.Combine(p.Root, "runtime");
            p.RuntimePython = Path.Combine(p.Runtime, "Scripts\\python.exe");
            p.PythonW = Path.Combine(p.Runtime, "Scripts\\pythonw.exe");
            p.ReadyMarker = Path.Combine(p.Runtime, "midiconv-ready.txt");
            p.PythonInstallDir = Path.Combine(p.Root, "python");
            p.DefaultUvCache = Path.Combine(p.Root, ".uv-cache");
            p.SetupLog = Path.Combine(p.Root, "setup.log");
            p.OptionsFile = Path.Combine(p.Root, "setup-options.txt");
            p.IconFile = Path.Combine(p.Root, "assets\\MIDIConverter.ico");
            return p;
        }

        public bool RuntimeReady
        {
            get { return File.Exists(PythonW) && File.Exists(ReadyMarker); }
        }

        // uv builds packages that only exist as source (pywebview's proxy-tools) inside its cache, about
        // 150 characters deeper than the cache folder. Without Windows long path support that build fails
        // once the cache path is longer than ~109 characters, so a long {app}\.uv-cache (deep install
        // folder) is replaced by a folder in %TEMP%.
        public const int MaxUvCacheLength = 90;

        /// <summary>MIDICONV_UV_CACHE if set (a cache kept between runs, not removed), else null.</summary>
        public string CustomUvCache
        {
            get
            {
                string custom = Environment.GetEnvironmentVariable("MIDICONV_UV_CACHE");
                return string.IsNullOrEmpty(custom) ? null : custom;
            }
        }

        public bool UsingCustomUvCache
        {
            get { return CustomUvCache != null; }
        }

        /// <summary>UV_CACHE_DIR for the setup: MIDICONV_UV_CACHE if set, else {app}\.uv-cache, or %TEMP%\MIDIConverter-uv-cache when that path is too long.</summary>
        public string UvCache
        {
            get
            {
                string custom = CustomUvCache;
                if (custom != null) return custom;
                if (DefaultUvCache.Length <= MaxUvCacheLength) return DefaultUvCache;
                string temp;
                try { temp = Path.Combine(Path.GetTempPath(), "MIDIConverter-uv-cache"); }
                catch (Exception) { return DefaultUvCache; }
                return temp.Length < DefaultUvCache.Length ? temp : DefaultUvCache;
            }
        }

        public bool CanWriteInstallDir()
        {
            string probe = Path.Combine(Root, ".write-test-" + Guid.NewGuid().ToString("N"));
            try
            {
                using (new FileStream(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose)) { }
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>Whether the last explicit setup included the Aria-AMT engine (used by repair runs).</summary>
        public bool ReadSavedWithAria()
        {
            try
            {
                if (!File.Exists(OptionsFile)) return false;
                foreach (string line in File.ReadAllLines(OptionsFile))
                {
                    if (line.Trim().Equals("with-aria=1", StringComparison.OrdinalIgnoreCase)) return true;
                }
            }
            catch (Exception) { }
            return false;
        }

        public void SaveWithAria(bool withAria)
        {
            try
            {
                File.WriteAllText(OptionsFile, "# Written by MIDI Converter's setup; used when it has to finish the setup again.\r\n" +
                                               "with-aria=" + (withAria ? "1" : "0") + "\r\n", new UTF8Encoding(false));
            }
            catch (Exception) { }
        }
    }

    internal static class CommandLine
    {
        /// <summary>Quote one argument for CommandLineToArgvW / the MSVC runtime (what Python and uv use).</summary>
        public static string Quote(string arg)
        {
            if (arg == null) arg = "";
            if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
            StringBuilder sb = new StringBuilder();
            sb.Append('"');
            int backslashes = 0;
            foreach (char c in arg)
            {
                if (c == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (c == '"')
                {
                    sb.Append('\\', backslashes * 2 + 1);
                    sb.Append('"');
                }
                else
                {
                    sb.Append('\\', backslashes);
                    sb.Append(c);
                }
                backslashes = 0;
            }
            sb.Append('\\', backslashes * 2);
            sb.Append('"');
            return sb.ToString();
        }

        public static string Join(IEnumerable<string> args)
        {
            StringBuilder sb = new StringBuilder();
            foreach (string a in args)
            {
                if (sb.Length > 0) sb.Append(' ');
                sb.Append(Quote(a));
            }
            return sb.ToString();
        }
    }

    /// <summary>Environment for the child processes: drop variables that could redirect Python or uv elsewhere.</summary>
    internal static class Env
    {
        // uv variables a user may legitimately need on their network; every other UV_* is removed.
        private static readonly string[] KeepUv =
        {
            "UV_NATIVE_TLS", "UV_SYSTEM_CERTS", "UV_INSECURE_HOST", "UV_HTTP_TIMEOUT", "UV_HTTP_RETRIES",
            "UV_PYTHON_INSTALL_MIRROR", "UV_CONCURRENT_DOWNLOADS"
        };

        private static void Clean(System.Collections.Specialized.StringDictionary env, bool stripUv)
        {
            List<string> remove = new List<string>();
            foreach (string key in env.Keys)
            {
                string k = key.ToUpperInvariant();
                if (k.StartsWith("PYTHON") || k == "VIRTUAL_ENV" || k == "CONDA_PREFIX" || k == "CONDA_DEFAULT_ENV")
                    remove.Add(key);
                else if (stripUv && k.StartsWith("UV_") && Array.IndexOf(KeepUv, k) < 0)
                    remove.Add(key);
            }
            foreach (string key in remove) env.Remove(key);
        }

        public static void PrepareForApp(System.Collections.Specialized.StringDictionary env)
        {
            Clean(env, false);
            env["PYTHONNOUSERSITE"] = "1";
            env["PYTHONUTF8"] = "1";
        }

        public static void PrepareForSetup(System.Collections.Specialized.StringDictionary env, AppPaths paths)
        {
            Clean(env, true);
            env["UV_PYTHON_INSTALL_DIR"] = paths.PythonInstallDir;
            string cache = paths.UvCache;
            env["UV_CACHE_DIR"] = cache; // MIDICONV_UV_CACHE itself passes through when set
            // setup_runtime.py takes its cache from MIDICONV_UV_CACHE (else {app}\.uv-cache, which it removes
            // itself): pass the %TEMP% replacement that way. The worker removes it at the end.
            if (!paths.UsingCustomUvCache && !string.Equals(cache, paths.DefaultUvCache, StringComparison.OrdinalIgnoreCase))
                env["MIDICONV_UV_CACHE"] = cache;
            env["UV_NO_CONFIG"] = "1";
            env["UV_PYTHON_PREFERENCE"] = "only-managed";
            env["UV_NO_PROGRESS"] = "1";
            env["PYTHONUTF8"] = "1";
            env["PYTHONNOUSERSITE"] = "1";
            env["PYTHONUNBUFFERED"] = "1";
        }
    }
}

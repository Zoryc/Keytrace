using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace KeytraceLauncher
{
    internal static class Native
    {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr FindWindow(string className, string windowName);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetForegroundWindow(IntPtr hwnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ShowWindow(IntPtr hwnd, int cmd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsIconic(IntPtr hwnd);

        private const int SW_RESTORE = 9;

        /// <summary>Group the setup window with the app's pinned shortcut on the taskbar.</summary>
        public static void SetAppUserModelId(string id)
        {
            try { SetCurrentProcessExplicitAppUserModelID(id); } catch (Exception) { }
        }

        public static void ActivateWindowByTitle(string title)
        {
            try
            {
                IntPtr h = FindWindow(null, title);
                if (h == IntPtr.Zero) return;
                if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
                SetForegroundWindow(h);
            }
            catch (Exception) { }
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct TEXTMETRIC
        {
            public int tmHeight, tmAscent, tmDescent, tmInternalLeading, tmExternalLeading, tmAveCharWidth, tmMaxCharWidth,
                       tmWeight, tmOverhang, tmDigitizedAspectX, tmDigitizedAspectY;
            public char tmFirstChar, tmLastChar, tmDefaultChar, tmBreakChar;
            public byte tmItalic, tmUnderlined, tmStruckOut, tmPitchAndFamily, tmCharSet;
        }

        [DllImport("gdi32.dll", CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetTextMetrics(IntPtr hdc, out TEXTMETRIC tm);

        [DllImport("gdi32.dll")]
        private static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);

        [DllImport("gdi32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DeleteObject(IntPtr obj);

        /// <summary>The font's ascent in pixels as GDI (TextRenderer) uses it: the baseline is this far below the top
        /// of the text it draws. -1 if it cannot be read.</summary>
        public static int GdiAscent(System.Drawing.Graphics g, System.Drawing.Font font)
        {
            IntPtr hdc = g.GetHdc();
            IntPtr hfont = IntPtr.Zero;
            try
            {
                hfont = font.ToHfont();
                IntPtr old = SelectObject(hdc, hfont);
                TEXTMETRIC tm;
                bool ok = GetTextMetrics(hdc, out tm);
                SelectObject(hdc, old);
                return ok ? tm.tmAscent : -1;
            }
            catch (Exception)
            {
                return -1;
            }
            finally
            {
                if (hfont != IntPtr.Zero) DeleteObject(hfont);
                g.ReleaseHdc(hdc);
            }
        }
    }

    /// <summary>
    /// A Windows job object that kills every process in it (children and grandchildren) when terminated
    /// or when the launcher exits. The setup steps run in it, so Cancel stops uv and pip downloads too.
    /// </summary>
    internal sealed class JobObject : IDisposable
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

        private IntPtr handle;
        private readonly object sync = new object();

        public JobObject()
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) return;
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(handle, JobObjectExtendedLimitInformation, ref info,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
        }

        /// <summary>Put a started process in the job. Returns false if that is not possible (then use KillTree).</summary>
        public bool Assign(Process process)
        {
            lock (sync)
            {
                if (handle == IntPtr.Zero) return false;
                try { return AssignProcessToJobObject(handle, process.Handle); }
                catch (Exception) { return false; }
            }
        }

        public void Terminate()
        {
            lock (sync)
            {
                if (handle != IntPtr.Zero) TerminateJobObject(handle, 1);
            }
        }

        public void Dispose()
        {
            lock (sync)
            {
                if (handle != IntPtr.Zero)
                {
                    CloseHandle(handle);
                    handle = IntPtr.Zero;
                }
            }
        }

        /// <summary>Fallback when a process could not be put in the job: taskkill /T /F.</summary>
        public static void KillTree(int pid)
        {
            try
            {
                string taskkill = System.IO.Path.Combine(Environment.SystemDirectory, "taskkill.exe");
                ProcessStartInfo psi = new ProcessStartInfo(taskkill, "/PID " + pid + " /T /F");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                using (Process p = Process.Start(psi)) { p.WaitForExit(10000); }
            }
            catch (Exception) { }
        }
    }

    /// <summary>Progress on the taskbar button (ITaskbarList3). All calls are best effort.</summary>
    internal sealed class TaskbarProgress
    {
        [ComImport, Guid("ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface ITaskbarList3
        {
            // ITaskbarList
            void HrInit();
            void AddTab(IntPtr hwnd);
            void DeleteTab(IntPtr hwnd);
            void ActivateTab(IntPtr hwnd);
            void SetActiveAlt(IntPtr hwnd);
            // ITaskbarList2
            void MarkFullscreenWindow(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool fullscreen);
            // ITaskbarList3
            void SetProgressValue(IntPtr hwnd, ulong completed, ulong total);
            void SetProgressState(IntPtr hwnd, int state);
        }

        [ComImport, Guid("56FDF344-FD6D-11d0-958A-006097C9A090"), ClassInterface(ClassInterfaceType.None)]
        private class TaskbarListClass
        {
        }

        public const int NoProgress = 0;
        public const int Indeterminate = 1;
        public const int Normal = 2;
        public const int Error = 4;
        public const int Paused = 8;

        private ITaskbarList3 taskbar;

        public TaskbarProgress()
        {
            try
            {
                taskbar = (ITaskbarList3)new TaskbarListClass();
                taskbar.HrInit();
            }
            catch (Exception)
            {
                taskbar = null;
            }
        }

        public void SetState(IntPtr hwnd, int state)
        {
            if (taskbar == null) return;
            try { taskbar.SetProgressState(hwnd, state); } catch (Exception) { }
        }

        public void SetValue(IntPtr hwnd, double fraction)
        {
            if (taskbar == null) return;
            try { taskbar.SetProgressValue(hwnd, (ulong)(Math.Max(0, Math.Min(1, fraction)) * 1000), 1000); } catch (Exception) { }
        }
    }
}

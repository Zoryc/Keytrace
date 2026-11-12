using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace MidiConverterLauncher
{
    /// <summary>
    /// The setup window: icon + title, a one-line status, a progress bar, "Show details" (the log),
    /// and Cancel / Retry / Close / Open MIDI Converter. The work runs in SetupWorker on a background
    /// thread; status, progress and the result are marshalled with BeginInvoke, log lines are queued
    /// and taken by a 100 ms UI timer.
    /// </summary>
    internal sealed class SetupForm : Form
    {
        private enum UiState
        {
            Running,
            Cancelling,
            Failed,
            Succeeded
        }

        private const int MaxLogChars = 150000;  // shown in the window; the full log is in setup.log
        private const int KeepLogChars = 100000;
        private const int LogFlushMs = 100;
        private const int AutoCloseMs = 1500;
        private const int UnattendedErrorCloseMs = 6000; // --unattended: close after a failure too

        private readonly AppPaths paths;
        private readonly bool withAria;
        private readonly bool quiet;
        private readonly bool unattended;
        private readonly SetupMode mode;
        private readonly List<string> appArgs;
        private readonly float scale;

        private readonly LogoView logo;
        private readonly Label title;
        private readonly Label status;
        private readonly SlimProgressBar bar;
        private readonly Label percent;
        private readonly LinkLabel detailsLink;
        private readonly BorderPanel logPanel;
        private readonly TextBox logBox;
        private readonly FooterPanel footer;
        private readonly FlatButton primaryButton;
        private readonly FlatButton secondaryButton;
        private readonly Timer closeTimer;

        private TaskbarProgress taskbar;
        private SetupWorker worker;
        private UiState state;
        private bool detailsVisible;
        private bool confirming;
        private bool allowClose;

        private readonly object logSync = new object();
        private readonly StringBuilder pendingLog = new StringBuilder(); // filled by worker threads (logSync)
        private readonly StringBuilder logShadow = new StringBuilder();  // UI thread: recent lines
        private readonly Timer logTimer;
        private bool logBoxStale;
        private bool logTrimmed;

        public SetupOutcome Outcome { get; private set; }

        public SetupForm(AppPaths paths, bool withAria, bool quiet, bool unattended, SetupMode mode, List<string> appArgs)
        {
            this.paths = paths;
            this.withAria = withAria;
            this.quiet = quiet;
            this.unattended = unattended;
            this.mode = mode;
            this.appArgs = appArgs;
            Outcome = SetupOutcome.None;

            using (Graphics g = CreateGraphics()) scale = g.DpiX / 96f;

            SuspendLayout();
            AutoScaleMode = AutoScaleMode.None;
            Font = new Font("Segoe UI", 10f);
            BackColor = Theme.Surface;
            ForeColor = Theme.Ink;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            MinimizeBox = true;
            StartPosition = FormStartPosition.CenterScreen;
            Text = Program.SetupWindowTitle;
            Icon = LoadAppIcon();

            logo = new LogoView();

            title = new Label();
            title.AutoSize = false;
            title.UseMnemonic = false;
            title.Font = TitleFont();
            title.ForeColor = Theme.Ink;
            title.Text = "Setting up MIDI Converter";

            status = new Label();
            status.AutoSize = false;
            status.UseMnemonic = false;
            status.AutoEllipsis = true;
            status.ForeColor = Theme.Muted;

            bar = new SlimProgressBar();

            percent = new Label();
            percent.AutoSize = false;
            percent.TextAlign = ContentAlignment.MiddleRight;
            percent.ForeColor = Theme.Muted;
            percent.Font = new Font("Segoe UI", 9.5f);

            detailsLink = new LinkLabel();
            detailsLink.AutoSize = false;
            detailsLink.TextAlign = ContentAlignment.MiddleLeft;
            detailsLink.Font = new Font("Segoe UI", 9.5f);
            detailsLink.LinkBehavior = LinkBehavior.HoverUnderline;
            detailsLink.LinkColor = Theme.Accent;
            detailsLink.ActiveLinkColor = Theme.AccentPressed;
            detailsLink.VisitedLinkColor = Theme.Accent;
            detailsLink.Text = "Show details";
            detailsLink.TabIndex = 1;
            detailsLink.LinkClicked += delegate { ToggleDetails(); };

            logPanel = new BorderPanel();
            logPanel.Visible = false;
            logBox = new TextBox();
            logBox.Multiline = true;
            logBox.ReadOnly = true;
            logBox.WordWrap = true;
            logBox.ScrollBars = ScrollBars.Vertical;
            logBox.BorderStyle = BorderStyle.None;
            logBox.BackColor = Theme.Surface2;
            logBox.ForeColor = Theme.Ink2;
            logBox.Font = Theme.MonoFont(9f);
            logBox.MaxLength = 0; // no limit
            logBox.TabIndex = 2;
            logPanel.Controls.Add(logBox);

            footer = new FooterPanel();
            primaryButton = new FlatButton();
            primaryButton.Primary = true;
            primaryButton.TabIndex = 0;
            primaryButton.Click += OnPrimaryClick;
            secondaryButton = new FlatButton();
            secondaryButton.TabIndex = 1;
            secondaryButton.Click += OnSecondaryClick;
            footer.Controls.Add(primaryButton);
            footer.Controls.Add(secondaryButton);
            footer.TabIndex = 3;

            Controls.Add(logo);
            Controls.Add(title);
            Controls.Add(status);
            Controls.Add(bar);
            Controls.Add(percent);
            Controls.Add(detailsLink);
            Controls.Add(logPanel);
            Controls.Add(footer);

            closeTimer = new Timer();
            closeTimer.Interval = AutoCloseMs;
            closeTimer.Tick += OnCloseTimer;
            logTimer = new Timer();
            logTimer.Interval = LogFlushMs;
            logTimer.Tick += delegate { FlushLog(); };
            logTimer.Start();

            DoLayout();
            ResumeLayout(false);
        }

        private int S(float v)
        {
            return (int)Math.Round(v * scale);
        }

        private static Font TitleFont()
        {
            Font f = new Font("Segoe UI Semibold", 14f);
            if (string.Equals(f.Name, "Segoe UI Semibold", StringComparison.OrdinalIgnoreCase)) return f;
            f.Dispose();
            return new Font("Segoe UI", 14f, FontStyle.Bold);
        }

        private static Icon LoadAppIcon()
        {
            try
            {
                Stream s = typeof(SetupForm).Assembly.GetManifestResourceStream("MIDIConverter.ico");
                if (s != null)
                {
                    using (s) return new Icon(s);
                }
            }
            catch (Exception) { }
            try { return Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch (Exception) { return null; }
        }

        private void DoLayout()
        {
            int width = S(540);
            int pad = S(28);
            int inner = width - 2 * pad;

            logo.SetBounds(pad, S(28), S(48), S(48));
            int textX = pad + S(48) + S(16);
            title.SetBounds(textX, S(25), width - textX - pad, S(32));
            status.SetBounds(textX, S(58), width - textX - pad, S(44));

            int y = S(114);
            bar.SetBounds(pad, y, inner, S(6));
            y += S(6) + S(10);
            detailsLink.SetBounds(pad, y, S(160), S(22));
            percent.SetBounds(width - pad - S(120), y, S(120), S(22));
            y += S(22) + S(14);

            if (detailsVisible)
            {
                int h = S(230);
                logPanel.SetBounds(pad, y, inner, h);
                logBox.SetBounds(S(12), S(9), inner - S(18), h - S(18));
                y += h + S(22);
            }
            logPanel.Visible = detailsVisible;

            int footerH = S(64);
            footer.SetBounds(0, y, width, footerH);
            int bh = S(34);
            int by = (footerH - bh) / 2;
            int x = width - pad;
            foreach (FlatButton b in new FlatButton[] { secondaryButton, primaryButton })
            {
                if (!b.Visible) continue;
                int bw = Math.Max(S(96), TextRenderer.MeasureText(b.Text, b.Font).Width + S(36));
                x -= bw;
                b.SetBounds(x, by, bw, bh);
                x -= S(8);
            }
            ClientSize = new Size(width, y + footerH);
        }

        private void SetButtons(string primaryText, string secondaryText)
        {
            primaryButton.Visible = primaryText != null;
            if (primaryText != null) primaryButton.Text = primaryText;
            secondaryButton.Visible = secondaryText != null;
            if (secondaryText != null) secondaryButton.Text = secondaryText;
            secondaryButton.Enabled = true;
            primaryButton.Enabled = true;
            AcceptButton = primaryText != null ? primaryButton : null;
            CancelButton = secondaryText != null ? secondaryButton : null;
            DoLayout();
            if (primaryButton.Visible) primaryButton.Focus();
            else if (secondaryButton.Visible) secondaryButton.Focus();
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            taskbar = new TaskbarProgress();
            StartRun();
            Activate();
        }

        private void StartRun()
        {
            closeTimer.Stop();
            state = UiState.Running;
            Outcome = SetupOutcome.None;
            title.Text = "Setting up MIDI Converter";
            status.ForeColor = Theme.Muted;
            status.Text = mode == SetupMode.Repair
                ? "MIDI Converter needs to finish installing its components."
                : "Getting ready…";
            bar.FillColor = Theme.Accent;
            bar.Value = 0;
            bar.Snap();
            bar.Active = true;
            percent.Visible = true;
            percent.Text = "0%";
            SetButtons(null, "Cancel");
            taskbar.SetState(Handle, TaskbarProgress.Normal);
            taskbar.SetValue(Handle, 0);

            worker = new SetupWorker(paths, withAria);
            worker.StatusChanged += delegate(string text)
            {
                Post(delegate
                {
                    if (state == UiState.Running || state == UiState.Cancelling) status.Text = text;
                });
            };
            worker.ProgressChanged += delegate(double v)
            {
                Post(delegate
                {
                    if (state != UiState.Running) return;
                    bar.Value = v;
                    percent.Text = ((int)Math.Floor(v * 100)).ToString() + "%";
                    taskbar.SetValue(Handle, v);
                });
            };
            worker.LogLine += QueueLog;
            worker.Finished += delegate(SetupOutcome outcome, string message)
            {
                Post(delegate { OnFinished(outcome, message); });
            };
            worker.Start();
        }

        private void OnFinished(SetupOutcome outcome, string message)
        {
            FlushLog();
            bar.Active = false;
            switch (outcome)
            {
                case SetupOutcome.Success:
                    state = UiState.Succeeded;
                    Outcome = SetupOutcome.Success;
                    title.Text = "MIDI Converter is ready";
                    status.ForeColor = Theme.Ink2;
                    status.Text = message;
                    bar.Value = 1;
                    percent.Text = "100%";
                    taskbar.SetState(Handle, TaskbarProgress.NoProgress);
                    if (mode == SetupMode.Repair)
                    {
                        status.Text = message + "\nStarting MIDI Converter…";
                        SetButtons(null, null);
                        if (!Program.LaunchApp(paths, appArgs, this)) Outcome = SetupOutcome.Failed;
                        closeTimer.Interval = AutoCloseMs;
                        closeTimer.Start();
                    }
                    else if (quiet)
                    {
                        SetButtons(null, "Close");
                        closeTimer.Interval = AutoCloseMs;
                        closeTimer.Start();
                    }
                    else
                    {
                        SetButtons("Open MIDI Converter", "Close");
                    }
                    break;

                case SetupOutcome.Cancelled:
                    Outcome = SetupOutcome.Cancelled;
                    allowClose = true;
                    Close();
                    break;

                default:
                    state = UiState.Failed;
                    Outcome = SetupOutcome.Failed;
                    title.Text = "Setup couldn’t finish";
                    status.ForeColor = Theme.Danger;
                    status.Text = string.IsNullOrEmpty(message) ? "Something went wrong while installing the components." : message;
                    bar.FillColor = Theme.Danger;
                    percent.Visible = false;
                    taskbar.SetState(Handle, TaskbarProgress.Error);
                    SetButtons("Retry", "Close");
                    FlashIfInactive();
                    if (unattended)
                    {
                        // A silent install must not wait for a click: the app finishes the setup when it is opened.
                        closeTimer.Interval = UnattendedErrorCloseMs;
                        closeTimer.Start();
                    }
                    break;
            }
        }

        private void FlashIfInactive()
        {
            if (Form.ActiveForm != this) Activate();
        }

        private void OnPrimaryClick(object sender, EventArgs e)
        {
            if (state == UiState.Failed)
            {
                StartRun();
            }
            else if (state == UiState.Succeeded)
            {
                if (Program.LaunchApp(paths, null, this))
                {
                    allowClose = true;
                    Close();
                }
            }
        }

        private void OnSecondaryClick(object sender, EventArgs e)
        {
            if (state == UiState.Running)
            {
                RequestCancel();
            }
            else if (state == UiState.Failed || state == UiState.Succeeded)
            {
                allowClose = true;
                Close();
            }
        }

        private void RequestCancel()
        {
            if (state != UiState.Running || confirming) return;
            confirming = true;
            DialogResult answer;
            try
            {
                answer = MessageBox.Show(this,
                    "Stop setting up MIDI Converter?\n\n" +
                    "MIDI Converter can’t be used until its components are installed. " +
                    "You can finish the setup later by opening MIDI Converter.",
                    Program.SetupWindowTitle, MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
            }
            finally
            {
                confirming = false;
            }
            if (answer != DialogResult.Yes || state != UiState.Running) return;
            state = UiState.Cancelling;
            status.Text = "Cancelling…";
            secondaryButton.Enabled = false;
            bar.Active = false;
            taskbar.SetState(Handle, TaskbarProgress.Paused);
            worker.Cancel();
        }

        private void OnCloseTimer(object sender, EventArgs e)
        {
            if (confirming) return; // try again on the next tick
            closeTimer.Stop();
            allowClose = true;
            Close();
        }

        private void ToggleDetails()
        {
            detailsVisible = !detailsVisible;
            if (state == UiState.Failed) closeTimer.Stop(); // someone is reading the log: stay open
            detailsLink.Text = detailsVisible ? "Hide details" : "Show details";
            DoLayout();
            if (detailsVisible)
            {
                FlushLog();
                if (logBoxStale) RefreshLogBox();
                logBox.SelectionStart = logBox.TextLength;
                logBox.ScrollToCaret();
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            bool busy = state == UiState.Running || state == UiState.Cancelling;
            if (busy && !allowClose)
            {
                if (e.CloseReason == CloseReason.WindowsShutDown || e.CloseReason == CloseReason.TaskManagerClosing)
                {
                    if (worker != null) worker.Cancel();
                    Outcome = SetupOutcome.Cancelled;
                }
                else
                {
                    e.Cancel = true;
                    if (state == UiState.Running) BeginInvoke(new MethodInvoker(RequestCancel));
                    return;
                }
            }
            closeTimer.Stop();
            base.OnFormClosing(e);
        }

        // ---- log: lines arrive on worker threads; the UI takes them in batches every 100 ms ----
        // The window keeps only the most recent lines (the full log is in setup.log), and the text box
        // is only updated while it is visible, so heavy output never slows the window down.

        private void QueueLog(string line)
        {
            lock (logSync)
            {
                pendingLog.Append(line).Append("\r\n");
            }
        }

        private void FlushLog()
        {
            string text;
            lock (logSync)
            {
                if (pendingLog.Length == 0) return;
                text = pendingLog.ToString();
                pendingLog.Length = 0;
            }
            logShadow.Append(text);
            bool trimmed = false;
            if (logShadow.Length > MaxLogChars)
            {
                string all = logShadow.ToString();
                int nl = all.IndexOf('\n', all.Length - KeepLogChars); // keep whole lines
                int start = nl < 0 ? all.Length - KeepLogChars : nl + 1;
                logShadow.Length = 0;
                logShadow.Append(all, start, all.Length - start);
                logTrimmed = true;
                trimmed = true;
            }
            if (!detailsVisible)
            {
                logBoxStale = true;
                return;
            }
            if (trimmed || logBoxStale) RefreshLogBox();
            else logBox.AppendText(text);
        }

        private void RefreshLogBox()
        {
            string head = logTrimmed && worker != null ? "(earlier lines are in " + worker.LogFilePath + ")\r\n" : "";
            logBox.Text = head + logShadow.ToString();
            logBox.SelectionStart = logBox.TextLength;
            logBox.ScrollToCaret();
            logBoxStale = false;
        }

        private void Post(MethodInvoker action)
        {
            try
            {
                if (IsHandleCreated && !IsDisposed) BeginInvoke(action);
            }
            catch (InvalidOperationException) { } // includes ObjectDisposedException: the window is closing
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                closeTimer.Dispose();
                logTimer.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}

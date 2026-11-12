using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace KeytraceLauncher
{
    /// <summary>The app's "Essential" colours (web/styles.css, light theme).</summary>
    internal static class Theme
    {
        public static readonly Color Accent = Color.FromArgb(0x2C, 0x75, 0x67);
        public static readonly Color AccentHover = Color.FromArgb(0x24, 0x65, 0x5A);
        public static readonly Color AccentPressed = Color.FromArgb(0x1D, 0x56, 0x4C);
        public static readonly Color AccentDisabled = Color.FromArgb(0xA0, 0xC1, 0xBB); // accent at 45% on white
        public static readonly Color AccentSoft = Color.FromArgb(0xEA, 0xF3, 0xF0);     // --tint: the progress track
        public static readonly Color Surface = Color.White;
        public static readonly Color Surface2 = Color.FromArgb(0xF6, 0xF8, 0xF7);       // --bg
        public static readonly Color Ink = Color.FromArgb(0x1B, 0x25, 0x23);
        public static readonly Color Ink2 = Color.FromArgb(0x39, 0x45, 0x42);
        public static readonly Color Muted = Color.FromArgb(0x5D, 0x69, 0x66);
        public static readonly Color Line = Color.FromArgb(0xE0, 0xE7, 0xE4);
        public static readonly Color Line2 = Color.FromArgb(0xED, 0xF1, 0xEF);
        public static readonly Color Danger = Color.FromArgb(0xB0, 0x3A, 0x3A);
        public static readonly Color HoverGray = Color.FromArgb(0xF1, 0xF5, 0xF3);
        public static readonly Color PressedGray = Color.FromArgb(0xE6, 0xED, 0xEA);

        public static GraphicsPath RoundedRect(RectangleF r, float radius)
        {
            GraphicsPath path = new GraphicsPath();
            float d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
            if (d <= 0.5f)
            {
                path.AddRectangle(r);
                return path;
            }
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        public static Font MonoFont(float size)
        {
            foreach (string name in new string[] { "Cascadia Mono", "Consolas" })
            {
                Font f = TryFont(name, size, FontStyle.Regular);
                if (f != null) return f;
            }
            return new Font(FontFamily.GenericMonospace, size);
        }

        // The wordmark: "Keytrace" in Sitka Display Semibold, "Key" in ink and "trace" in teal (the web's .wordmark:
        // font-family "Sitka Display", Sitka, Georgia, serif; font-weight 600).
        public const string WordmarkHead = "Key";
        public const string WordmarkTail = "trace";
        public static readonly Color WordmarkHeadColor = Ink;
        public static readonly Color WordmarkTailColor = Accent;

        /// <summary>Sitka Display Semibold (Windows 11's variable Sitka), else Sitka Display Bold (Windows 10's Sitka has
        /// no semibold), else Georgia Bold, like the web's font stack.</summary>
        public static Font WordmarkFont(float size)
        {
            Font f = TryFont("Sitka Display Semibold", size, FontStyle.Regular)
                  ?? TryFont("Sitka Display", size, FontStyle.Bold)
                  ?? TryFont("Georgia", size, FontStyle.Bold);
            return f ?? new Font(FontFamily.GenericSerif, size, FontStyle.Bold);
        }

        /// <summary>The font, or null when it is not installed (GDI+ would silently substitute another one).</summary>
        public static Font TryFont(string name, float size, FontStyle style)
        {
            try
            {
                Font f = new Font(name, size, style);
                if (string.Equals(f.Name, name, StringComparison.OrdinalIgnoreCase)) return f;
                f.Dispose();
            }
            catch (ArgumentException) { } // e.g. a family without that style
            return null;
        }
    }

    /// <summary>A rounded button, primary (accent) or secondary (outlined). Keeps Button's keyboard and accessibility behaviour.</summary>
    internal sealed class FlatButton : Button
    {
        private bool hover;
        private bool pressed;
        private bool primary;

        public FlatButton()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            Cursor = Cursors.Hand;
            UseVisualStyleBackColor = false;
        }

        public bool Primary
        {
            get { return primary; }
            set { primary = value; Invalidate(); }
        }

        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; pressed = false; Invalidate(); base.OnMouseLeave(e); }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left) { pressed = true; Invalidate(); }
            base.OnMouseDown(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            pressed = false;
            Invalidate();
            base.OnMouseUp(e);
        }

        protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            Color parentBack = Parent != null ? Parent.BackColor : Theme.Surface;
            g.Clear(parentBack);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;

            float scale = DeviceDpiScale(g);
            float radius = 8 * scale;
            RectangleF r = new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f);
            Color fill, border, text;
            if (primary)
            {
                fill = !Enabled ? Theme.AccentDisabled : pressed ? Theme.AccentPressed : hover ? Theme.AccentHover : Theme.Accent;
                border = fill;
                text = Color.White;
            }
            else
            {
                fill = !Enabled ? Theme.Surface : pressed ? Theme.PressedGray : hover ? Theme.HoverGray : Theme.Surface;
                border = Theme.Line;
                text = Enabled ? Theme.Ink2 : Theme.Muted;
            }
            using (GraphicsPath path = Theme.RoundedRect(r, radius))
            {
                using (SolidBrush b = new SolidBrush(fill)) g.FillPath(b, path);
                using (Pen p = new Pen(border, 1f)) g.DrawPath(p, path);
            }
            if (Focused && ShowFocusCues)
            {
                RectangleF fr = RectangleF.Inflate(r, -2.5f * scale, -2.5f * scale);
                using (GraphicsPath path = Theme.RoundedRect(fr, Math.Max(1, radius - 2.5f * scale)))
                using (Pen p = new Pen(primary ? Color.FromArgb(200, Color.White) : Theme.Accent, 1.5f * scale))
                {
                    g.DrawPath(p, path);
                }
            }
            TextRenderer.DrawText(g, Text, Font, ClientRectangle, text,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine |
                TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
        }

        private static float DeviceDpiScale(Graphics g)
        {
            return g.DpiX / 96f;
        }
    }

    /// <summary>A slim rounded progress bar with smooth easing and a soft moving highlight while active.</summary>
    internal sealed class SlimProgressBar : Control
    {
        private double target;
        private double shown;
        private bool active;
        private float shimmer;
        private Color fillColor = Theme.Accent;
        private readonly Timer timer;

        public SlimProgressBar()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            SetStyle(ControlStyles.Selectable, false);
            TabStop = false;
            timer = new Timer();
            timer.Interval = 33;
            timer.Tick += OnTick;
        }

        public double Value
        {
            get { return target; }
            set
            {
                target = Math.Max(0.0, Math.Min(1.0, value));
                if (!timer.Enabled) timer.Start();
            }
        }

        /// <summary>Show the moving highlight (work is in progress).</summary>
        public bool Active
        {
            get { return active; }
            set
            {
                active = value;
                if (active && !timer.Enabled) timer.Start();
                Invalidate();
            }
        }

        public Color FillColor
        {
            get { return fillColor; }
            set { fillColor = value; Invalidate(); }
        }

        /// <summary>Jump straight to the target value (no easing).</summary>
        public void Snap()
        {
            shown = target;
            Invalidate();
        }

        private void OnTick(object sender, EventArgs e)
        {
            double diff = target - shown;
            if (Math.Abs(diff) < 0.0005) shown = target;
            else shown += diff * 0.18;
            if (active)
            {
                shimmer += 0.012f;
                if (shimmer > 1.6f) shimmer = -0.6f;
            }
            if (!active && shown == target) timer.Stop();
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(Parent != null ? Parent.BackColor : Theme.Surface);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            float h = Height;
            RectangleF track = new RectangleF(0, 0, Width, h);
            using (GraphicsPath path = Theme.RoundedRect(track, h / 2))
            using (SolidBrush b = new SolidBrush(Theme.AccentSoft))
            {
                g.FillPath(b, path);
            }
            float w = (float)(Width * shown);
            if (w <= 0.5f) return;
            w = Math.Max(w, h); // keep the rounded ends round
            RectangleF fill = new RectangleF(0, 0, w, h);
            using (GraphicsPath path = Theme.RoundedRect(fill, h / 2))
            {
                using (SolidBrush b = new SolidBrush(fillColor)) g.FillPath(b, path);
                if (active && w > h * 2)
                {
                    float band = Math.Max(Width * 0.25f, h * 4);
                    float x = shimmer * Width - band / 2;
                    RectangleF br = new RectangleF(x, 0, band, h);
                    using (LinearGradientBrush lg = new LinearGradientBrush(new RectangleF(x - 1, 0, band + 2, h),
                               Color.FromArgb(0, Color.White), Color.FromArgb(0, Color.White), LinearGradientMode.Horizontal))
                    {
                        ColorBlend blend = new ColorBlend(3);
                        blend.Colors = new Color[] { Color.FromArgb(0, Color.White), Color.FromArgb(70, Color.White), Color.FromArgb(0, Color.White) };
                        blend.Positions = new float[] { 0f, 0.5f, 1f };
                        lg.InterpolationColors = blend;
                        GraphicsState saved = g.Save();
                        g.SetClip(path, CombineMode.Intersect);
                        g.FillRectangle(lg, br);
                        g.Restore(saved);
                    }
                }
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) timer.Dispose();
            base.Dispose(disposing);
        }
    }

    /// <summary>
    /// A one-line headline in which the product name is drawn as the Keytrace wordmark (e.g. "Setting up Keytrace").
    /// The other words use <see cref="Control.Font"/> and <see cref="Control.ForeColor"/>; all runs share one
    /// baseline, <see cref="Baseline"/> pixels below the top. Drawn with GDI (TextRenderer), which also renders the
    /// named instances of variable fonts such as Sitka Display Semibold.
    /// </summary>
    internal sealed class TitleView : Control
    {
        private const TextFormatFlags Flags = TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix |
                                              TextFormatFlags.SingleLine | TextFormatFlags.NoClipping;
        private Font wordmarkFont;
        private int baseline;

        /// <summary>The baseline in pixels from the top; 0: the larger ascent of the two fonts.</summary>
        public int Baseline
        {
            get { return baseline; }
            set { baseline = value; Invalidate(); }
        }

        public TitleView()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            SetStyle(ControlStyles.Selectable, false);
            TabStop = false;
            AccessibleRole = AccessibleRole.StaticText;
        }

        public Font WordmarkFont
        {
            get { return wordmarkFont; }
            set { wordmarkFont = value; Invalidate(); }
        }

        protected override void OnTextChanged(EventArgs e)
        {
            base.OnTextChanged(e);
            AccessibleName = Text; // screen readers read the headline as the Label it replaces did
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(Parent != null ? Parent.BackColor : Theme.Surface);
            string text = Text ?? "";
            Font wm = wordmarkFont ?? Font;
            int y = baseline > 0 ? baseline : (int)Math.Round(Math.Max(Ascent(g, Font), Ascent(g, wm)));
            string name = Theme.WordmarkHead + Theme.WordmarkTail;
            int x = 0;
            int start = 0;
            while (true)
            {
                int at = text.IndexOf(name, start, StringComparison.Ordinal);
                x = DrawRun(g, at < 0 ? text.Substring(start) : text.Substring(start, at - start), Font, ForeColor, x, y);
                if (at < 0) break;
                x = DrawRun(g, Theme.WordmarkHead, wm, Theme.WordmarkHeadColor, x, y);
                x = DrawRun(g, Theme.WordmarkTail, wm, Theme.WordmarkTailColor, x, y);
                start = at + name.Length;
            }
        }

        /// <summary>Draw one run so that its baseline is at <paramref name="baseline"/>; returns the x after it.
        /// Leading and trailing spaces are measured separately (GDI does not count trailing spaces).</summary>
        private static int DrawRun(Graphics g, string run, Font font, Color color, int x, int baseline)
        {
            if (run.Length == 0) return x;
            string core = run.Trim(' ');
            int lead = core.Length == 0 ? run.Length : run.IndexOf(core, StringComparison.Ordinal);
            int trail = run.Length - lead - core.Length;
            float space = SpaceWidth(g, font);
            x += (int)Math.Round(lead * space);
            if (core.Length > 0)
            {
                int top = baseline - (int)Math.Round(Ascent(g, font));
                TextRenderer.DrawText(g, core, font, new Point(x, top), color, Flags);
                x += TextRenderer.MeasureText(g, core, font, new Size(int.MaxValue, int.MaxValue), Flags).Width;
            }
            return x + (int)Math.Round(trail * space);
        }

        /// <summary>The font's ascent in pixels: the distance from the top of a GDI text cell to the baseline. Read from
        /// GDI itself, since GDI+'s design metrics differ for some fonts (e.g. the Sitka variable font).</summary>
        private static float Ascent(Graphics g, Font font)
        {
            int gdi = Native.GdiAscent(g, font);
            if (gdi > 0) return gdi;
            FontFamily ff = font.FontFamily;
            return font.SizeInPoints * g.DpiY / 72f * ff.GetCellAscent(font.Style) / ff.GetEmHeight(font.Style);
        }

        private static float SpaceWidth(Graphics g, Font font)
        {
            Size big = new Size(int.MaxValue, int.MaxValue);
            return TextRenderer.MeasureText(g, "x x", font, big, Flags).Width - TextRenderer.MeasureText(g, "xx", font, big, Flags).Width;
        }
    }

    /// <summary>
    /// The Keytrace mark, as a frame of Keytrace.ico, which installer/make_icon.py renders from the master SVGs
    /// (web/brand/) at each of its sizes. The control draws the frame of exactly its size in pixels if the icon has
    /// one (48 and 96 px: 100% and 200%), else the smallest frame at least twice as large (else the largest),
    /// scaled down once per size with bicubic filtering, so the mark stays crisp at any DPI. The icon is read from
    /// {app}\assets\Keytrace.ico, else from the copy embedded in the exe. Its colours are fixed (both themes).
    /// </summary>
    internal sealed class LogoView : Control
    {
        private readonly SortedDictionary<int, Bitmap> frames;
        private Bitmap scaled; // the mark at the control's size, when no frame has that size

        public LogoView(string iconFile)
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint |
                     ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            SetStyle(ControlStyles.Selectable, false);
            TabStop = false;
            frames = IconFrames.FromFile(iconFile);
            if (frames.Count == 0) frames = IconFrames.FromResource(Program.IconResource);
        }

        protected override void OnSizeChanged(EventArgs e)
        {
            DropScaled();
            base.OnSizeChanged(e);
        }

        /// <summary>The frame to draw at <paramref name="size"/> pixels: that size, else the smallest at least
        /// twice as large (downscaling it is sharper than a small step down), else the largest.</summary>
        private Bitmap Source(int size)
        {
            Bitmap exact;
            if (frames.TryGetValue(size, out exact)) return exact;
            Bitmap best = null;
            foreach (KeyValuePair<int, Bitmap> f in frames) // ascending sizes
            {
                best = f.Value;
                if (f.Key >= 2 * size) break;
            }
            return best;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(Parent != null ? Parent.BackColor : Theme.Surface);
            int size = Math.Min(Width, Height);
            Bitmap src = size > 0 ? Source(size) : null;
            if (src == null) return;
            Bitmap mark = src;
            if (src.Width != size)
            {
                if (scaled == null || scaled.Width != size) { DropScaled(); scaled = IconFrames.Scale(src, size); }
                mark = scaled;
            }
            g.CompositingMode = CompositingMode.SourceOver;
            g.InterpolationMode = InterpolationMode.NearestNeighbor; // a 1:1 copy
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.DrawImage(mark, new Rectangle(0, 0, size, size), 0, 0, size, size, GraphicsUnit.Pixel);
        }

        private void DropScaled()
        {
            if (scaled != null) { scaled.Dispose(); scaled = null; }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                DropScaled();
                foreach (Bitmap b in frames.Values) b.Dispose();
                frames.Clear();
            }
            base.Dispose(disposing);
        }
    }

    /// <summary>Reads the square frames of an .ico (32-bit BMP and PNG entries, as installer/make_icon.py writes
    /// them) into 32-bit ARGB bitmaps, keyed by size.</summary>
    internal static class IconFrames
    {
        public static SortedDictionary<int, Bitmap> FromFile(string path)
        {
            try
            {
                if (!string.IsNullOrEmpty(path) && File.Exists(path)) return Read(File.ReadAllBytes(path));
            }
            catch (Exception) { } // unreadable or not an icon: the caller falls back to the embedded copy
            return new SortedDictionary<int, Bitmap>();
        }

        public static SortedDictionary<int, Bitmap> FromResource(string name)
        {
            try
            {
                using (Stream s = typeof(IconFrames).Assembly.GetManifestResourceStream(name))
                {
                    if (s != null)
                    {
                        MemoryStream ms = new MemoryStream();
                        s.CopyTo(ms);
                        return Read(ms.ToArray());
                    }
                }
            }
            catch (Exception) { }
            return new SortedDictionary<int, Bitmap>();
        }

        public static SortedDictionary<int, Bitmap> Read(byte[] ico)
        {
            SortedDictionary<int, Bitmap> result = new SortedDictionary<int, Bitmap>();
            if (ico.Length < 6 || BitConverter.ToUInt16(ico, 0) != 0 || BitConverter.ToUInt16(ico, 2) != 1) return result;
            int count = BitConverter.ToUInt16(ico, 4);
            for (int i = 0; i < count && 6 + 16 * (i + 1) <= ico.Length; i++)
            {
                int entry = 6 + 16 * i;
                int width = ico[entry] == 0 ? 256 : ico[entry];
                int height = ico[entry + 1] == 0 ? 256 : ico[entry + 1];
                int length = BitConverter.ToInt32(ico, entry + 8);
                int offset = BitConverter.ToInt32(ico, entry + 12);
                if (width != height || result.ContainsKey(width) || length <= 0 || offset < 0 || offset > ico.Length - length)
                    continue;
                Bitmap frame = null;
                try { frame = IsPng(ico, offset) ? Png(ico, offset, length) : Dib(ico, offset, length); }
                catch (Exception) { }
                if (frame != null && frame.Width == width && frame.Height == width) result[width] = frame;
                else if (frame != null) frame.Dispose();
            }
            return result;
        }

        private static bool IsPng(byte[] b, int at)
        {
            return b.Length - at >= 8 && b[at] == 0x89 && b[at + 1] == 0x50 && b[at + 2] == 0x4E && b[at + 3] == 0x47;
        }

        private static Bitmap Png(byte[] b, int offset, int length)
        {
            using (MemoryStream ms = new MemoryStream(b, offset, length))
            using (Bitmap png = new Bitmap(ms))
            {
                Bitmap frame = new Bitmap(png.Width, png.Height, PixelFormat.Format32bppArgb);
                CopyPixels(png, frame);
                return frame;
            }
        }

        /// <summary>A 32-bit BGRA DIB (BITMAPINFOHEADER, bottom-up rows, then the AND mask, which is not needed).</summary>
        private static Bitmap Dib(byte[] b, int offset, int length)
        {
            int header = BitConverter.ToInt32(b, offset);
            int width = BitConverter.ToInt32(b, offset + 4);
            int height = BitConverter.ToInt32(b, offset + 8) / 2; // XOR image + AND mask
            int bits = BitConverter.ToUInt16(b, offset + 14);
            int stride = width * 4;
            if (header < 40 || bits != 32 || width <= 0 || height != width || header + stride * height > length) return null;
            Bitmap frame = new Bitmap(width, height, PixelFormat.Format32bppArgb);
            BitmapData data = frame.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            try
            {
                for (int y = 0; y < height; y++)
                    Marshal.Copy(b, offset + header + (height - 1 - y) * stride, new IntPtr(data.Scan0.ToInt64() + (long)y * data.Stride), stride);
            }
            finally { frame.UnlockBits(data); }
            return frame;
        }

        private static void CopyPixels(Bitmap from, Bitmap to)
        {
            Rectangle r = new Rectangle(0, 0, from.Width, from.Height);
            BitmapData src = from.LockBits(r, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                BitmapData dst = to.LockBits(r, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
                try
                {
                    byte[] row = new byte[r.Width * 4];
                    for (int y = 0; y < r.Height; y++)
                    {
                        Marshal.Copy(new IntPtr(src.Scan0.ToInt64() + (long)y * src.Stride), row, 0, row.Length);
                        Marshal.Copy(row, 0, new IntPtr(dst.Scan0.ToInt64() + (long)y * dst.Stride), row.Length);
                    }
                }
                finally { to.UnlockBits(dst); }
            }
            finally { from.UnlockBits(src); }
        }

        /// <summary>The frame scaled to size x size with high-quality bicubic filtering, in premultiplied alpha so
        /// that the transparent surround does not darken the anti-aliased edges.</summary>
        public static Bitmap Scale(Bitmap frame, int size)
        {
            Bitmap result = new Bitmap(size, size, PixelFormat.Format32bppPArgb);
            using (Graphics g = Graphics.FromImage(result))
            using (ImageAttributes edges = new ImageAttributes())
            {
                edges.SetWrapMode(WrapMode.TileFlipXY); // no faint border from sampling outside the frame
                g.CompositingMode = CompositingMode.SourceCopy;
                g.CompositingQuality = CompositingQuality.HighQuality;
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(frame, new Rectangle(0, 0, size, size), 0, 0, frame.Width, frame.Height, GraphicsUnit.Pixel, edges);
            }
            return result;
        }
    }

    /// <summary>The light footer band with a hairline on top that holds the buttons.</summary>
    internal sealed class FooterPanel : Panel
    {
        public FooterPanel()
        {
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Surface2;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            using (Pen p = new Pen(Theme.Line2, 1f)) e.Graphics.DrawLine(p, 0, 0, Width, 0);
        }
    }

    /// <summary>Panel with a 1 px rounded border, used around the log.</summary>
    internal sealed class BorderPanel : Panel
    {
        public BorderPanel()
        {
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.ResizeRedraw, true);
            BackColor = Theme.Surface2;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(Parent != null ? Parent.BackColor : Theme.Surface);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            float scale = g.DpiX / 96f;
            using (GraphicsPath path = Theme.RoundedRect(new RectangleF(0.5f, 0.5f, Width - 1.5f, Height - 1.5f), 8 * scale))
            {
                using (SolidBrush b = new SolidBrush(BackColor)) g.FillPath(b, path);
                using (Pen p = new Pen(Theme.Line, 1f)) g.DrawPath(p, path);
            }
        }
    }
}

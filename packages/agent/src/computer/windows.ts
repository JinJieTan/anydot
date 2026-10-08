import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { base64ToBytes } from '@aitech/core'
import type { NativeDriver, Point, Size } from './driver'
import { winKeys } from './keys'

/**
 * A long-lived PowerShell process that compiles a small user32/GDI+ helper
 * once and then executes one JSON command per stdin line. Ships with Windows,
 * so there is nothing to install.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;

public static class AitechInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }

  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);

  public static void Init() { SetProcessDPIAware(); }
  public static int Width() { return GetSystemMetrics(0); }
  public static int Height() { return GetSystemMetrics(1); }
  public static POINT Cursor() { POINT p; GetCursorPos(out p); return p; }

  static void Send(params INPUT[] inputs) {
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length)
      throw new Exception("SendInput was blocked (is the target app running as administrator?)");
  }
  static INPUT M(uint flags, int data) { var i = new INPUT { type = 0 }; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; return i; }
  static INPUT K(ushort vk, ushort scan, uint flags) { var i = new INPUT { type = 1 }; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }

  public static void Move(int x, int y) { SetCursorPos(x, y); }
  public static void Button(string button, bool down) {
    uint f = button == "right" ? (down ? 0x8u : 0x10u) : button == "middle" ? (down ? 0x20u : 0x40u) : (down ? 0x2u : 0x4u);
    Send(M(f, 0));
  }
  public static void Click(int x, int y, string button, int count) {
    SetCursorPos(x, y);
    for (int i = 0; i < count; i++) { Button(button, true); Button(button, false); Thread.Sleep(40); }
  }
  public static void Drag(int x1, int y1, int x2, int y2) {
    SetCursorPos(x1, y1); Button("left", true);
    for (int i = 1; i <= 20; i++) { SetCursorPos(x1 + (x2 - x1) * i / 20, y1 + (y2 - y1) * i / 20); Thread.Sleep(10); }
    Button("left", false);
  }
  public static void Scroll(int x, int y, int dx, int dy) {
    SetCursorPos(x, y);
    if (dy != 0) Send(M(0x800, -dy * 120));
    if (dx != 0) Send(M(0x1000, dx * 120));
  }
  public static void Keys(int[] vks, int holdMs) {
    foreach (var vk in vks) Send(K((ushort)vk, 0, 0));
    if (holdMs > 0) Thread.Sleep(holdMs);
    foreach (var vk in vks.Reverse()) Send(K((ushort)vk, 0, 2));
  }
  public static void Type(string text) {
    foreach (char c in text) {
      if (c == '\r') continue;
      if (c == '\n') { Keys(new[] { 0x0D }, 0); continue; }
      Send(K(0, c, 4), K(0, c, 4 | 2));
    }
  }
  public static string Capture(int w, int h) {
    int sw = Width(), sh = Height();
    using (var full = new Bitmap(sw, sh))
    using (var scaled = new Bitmap(w, h)) {
      using (var g = Graphics.FromImage(full)) g.CopyFromScreen(0, 0, 0, 0, full.Size);
      using (var g = Graphics.FromImage(scaled)) {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.DrawImage(full, 0, 0, w, h);
      }
      var codec = ImageCodecInfo.GetImageEncoders().First(c => c.MimeType == "image/jpeg");
      var p = new EncoderParameters(1);
      p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 70L);
      using (var ms = new MemoryStream()) { scaled.Save(ms, codec, p); return Convert.ToBase64String(ms.ToArray()); }
    }
  }
}
'@
[AitechInput]::Init()
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$in = [Console]::In
while ($null -ne ($line = $in.ReadLine())) {
  try {
    $a = $line | ConvertFrom-Json
    $r = @{}
    switch ($a.op) {
      'screen' { $r = @{ width = [AitechInput]::Width(); height = [AitechInput]::Height() } }
      'cursor' { $p = [AitechInput]::Cursor(); $r = @{ x = $p.X; y = $p.Y } }
      'capture' { $r = @{ data = [AitechInput]::Capture($a.width, $a.height) } }
      'move' { [AitechInput]::Move($a.x, $a.y) }
      'click' { [AitechInput]::Click($a.x, $a.y, $a.button, $a.count) }
      'down' { [AitechInput]::Move($a.x, $a.y); [AitechInput]::Button('left', $true) }
      'up' { [AitechInput]::Move($a.x, $a.y); [AitechInput]::Button('left', $false) }
      'drag' { [AitechInput]::Drag($a.x1, $a.y1, $a.x2, $a.y2) }
      'scroll' { [AitechInput]::Scroll($a.x, $a.y, $a.dx, $a.dy) }
      'type' { [AitechInput]::Type($a.text) }
      'key' { [AitechInput]::Keys([int[]]$a.vks, [int]$a.hold) }
      default { throw "unknown op $($a.op)" }
    }
    [Console]::Out.WriteLine((@{ ok = $true; result = $r } | ConvertTo-Json -Compress))
  } catch {
    [Console]::Out.WriteLine((@{ ok = $false; error = "$_" } | ConvertTo-Json -Compress))
  }
}
`

interface Reply {
  ok: boolean
  result?: unknown
  error?: string
}

export function windowsDriver(): NativeDriver {
  let child: ChildProcessWithoutNullStreams | null = null
  const waiting: ((r: Reply) => void)[] = []
  // Commands are strictly sequential: one line in, one line out.
  let queue: Promise<unknown> = Promise.resolve()

  const start = () => {
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
    const proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true },
    )
    createInterface({ input: proc.stdout }).on('line', (line) => {
      if (!line.startsWith('{')) return
      try {
        waiting.shift()?.(JSON.parse(line) as Reply)
      } catch {
        waiting.shift()?.({ ok: false, error: `bad reply: ${line.slice(0, 200)}` })
      }
    })
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)))
    proc.on('exit', () => {
      if (child === proc) child = null
      for (const w of waiting.splice(0)) w({ ok: false, error: stderr.trim() || 'helper exited' })
    })
    child = proc
    return proc
  }

  const call = <T = unknown>(op: Record<string, unknown>): Promise<T> => {
    const next = queue.then(
      () =>
        new Promise<T>((resolve, reject) => {
          const proc = child ?? start()
          const timer = setTimeout(() => {
            proc.kill()
            reject(new Error('Windows input helper timed out'))
          }, 30_000)
          waiting.push((r) => {
            clearTimeout(timer)
            if (r.ok) resolve(r.result as T)
            else reject(new Error(`Windows input failed: ${r.error}`))
          })
          proc.stdin.write(`${JSON.stringify(op)}\n`)
        }),
    )
    queue = next.catch(() => {})
    return next
  }

  return {
    screenSize: () => call<Size>({ op: 'screen' }),
    cursor: () => call<Point>({ op: 'cursor' }),
    async capture(size) {
      const r = await call<{ data: string }>({ op: 'capture', ...size })
      return base64ToBytes(r.data)
    },
    move: (p) => call({ op: 'move', ...round(p) }).then(() => {}),
    click: (p, button, count) => call({ op: 'click', ...round(p), button, count }).then(() => {}),
    mouse: (kind, p) => call({ op: kind, ...round(p) }).then(() => {}),
    drag: (from, to) => {
      const a = round(from)
      const b = round(to)
      return call({ op: 'drag', x1: a.x, y1: a.y, x2: b.x, y2: b.y }).then(() => {})
    },
    scroll: (p, dx, dy) => call({ op: 'scroll', ...round(p), dx, dy }).then(() => {}),
    type: (text) => call({ op: 'type', text }).then(() => {}),
    key: (combo, holdMs) =>
      call({ op: 'key', vks: winKeys(combo), hold: holdMs ?? 0 }).then(() => {}),
    dispose() {
      child?.kill()
      child = null
    },
  }
}

const round = (p: Point): Point => ({ x: Math.round(p.x), y: Math.round(p.y) })

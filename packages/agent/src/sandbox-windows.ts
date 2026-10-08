import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Windows sandbox (experimental): a tiny launcher, compiled once with the
 * C# compiler that ships with Windows, runs the command with a
 * write-restricted token. Writes then also need an ACL entry for the
 * sandbox SID, which the launcher grants on the project, temp and
 * package-cache directories (and denies on .git/hooks and .git/config).
 *
 * Unlike the macOS sandbox this only restricts writes: reads (e.g. ~/.ssh)
 * are not blocked.
 */

// C# 5: the compiler in the .NET Framework is that old.
const LAUNCHER = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

static class AitechSandbox {
  // Fixed, so ACL entries granted once keep working across runs. An ordinary
  // (domain-style) SID: capability SIDs are rejected as restricting SIDs.
  const string SandboxSid = "S-1-5-21-2604117329-2836226339-1532462961-1848577813";

  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_DEFAULT_DACL { public IntPtr DefaultDacl; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars;
    public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr h);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool CreateRestrictedToken(IntPtr existing, uint flags,
    uint disableCount, IntPtr disable, uint deleteCount, IntPtr delete, uint restrictCount, SID_AND_ATTRIBUTES[] restrict, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int cls, IntPtr info, int len);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, int len, out int needed);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessAsUser(IntPtr token,
    string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd,
    ref STARTUPINFO si, out PROCESS_INFORMATION pi);

  static int Main(string[] argv) {
    var writable = new List<string>();
    var denied = new List<string>();
    int i = 0;
    for (; i < argv.Length; i++) {
      if (argv[i] == "--") { i++; break; }
      if (argv[i] == "--write" && i + 1 < argv.Length) writable.Add(argv[++i]);
      else if (argv[i] == "--deny-write" && i + 1 < argv.Length) denied.Add(argv[++i]);
      else { Console.Error.WriteLine("aitech-sandbox: bad option " + argv[i]); return 125; }
    }
    if (i >= argv.Length) { Console.Error.WriteLine("usage: aitech-sandbox [--write dir]... [--deny-write path]... -- program [args]"); return 125; }
    try {
      var sid = new SecurityIdentifier(SandboxSid);
      foreach (var d in writable) Grant(d, sid);
      foreach (var d in denied) Deny(d, sid);
      return Run(argv, i, sid);
    } catch (Exception e) {
      Console.Error.WriteLine("aitech-sandbox: " + e.Message);
      return 125;
    }
  }

  static bool HasRule(FileSystemSecurity sec, SecurityIdentifier sid, AccessControlType type) {
    foreach (FileSystemAccessRule r in sec.GetAccessRules(true, false, typeof(SecurityIdentifier)))
      if (r.IdentityReference.Equals(sid) && r.AccessControlType == type) return true;
    return false;
  }

  const FileSystemRights WriteRights = FileSystemRights.WriteData | FileSystemRights.AppendData |
    FileSystemRights.WriteExtendedAttributes | FileSystemRights.WriteAttributes | FileSystemRights.Delete |
    FileSystemRights.DeleteSubdirectoriesAndFiles;

  static void Grant(string dir, SecurityIdentifier sid) {
    if (!Directory.Exists(dir)) return;
    var sec = Directory.GetAccessControl(dir);
    if (HasRule(sec, sid, AccessControlType.Allow)) return;
    sec.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.Modify | FileSystemRights.Synchronize,
      InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
    Directory.SetAccessControl(dir, sec);
  }

  static void Deny(string path, SecurityIdentifier sid) {
    if (Directory.Exists(path)) {
      var sec = Directory.GetAccessControl(path);
      if (HasRule(sec, sid, AccessControlType.Deny)) return;
      sec.AddAccessRule(new FileSystemAccessRule(sid, WriteRights,
        InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Deny));
      Directory.SetAccessControl(path, sec);
    } else if (File.Exists(path)) {
      var sec = File.GetAccessControl(path);
      if (HasRule(sec, sid, AccessControlType.Deny)) return;
      sec.AddAccessRule(new FileSystemAccessRule(sid, WriteRights, AccessControlType.Deny));
      File.SetAccessControl(path, sec);
    }
  }

  static IntPtr SidPtr(SecurityIdentifier sid) {
    var bytes = new byte[sid.BinaryLength];
    sid.GetBinaryForm(bytes, 0);
    var p = Marshal.AllocHGlobal(bytes.Length);
    Marshal.Copy(bytes, 0, p, bytes.Length);
    return p;
  }

  // TOKEN_GROUPS from TokenLogonSid (28): { DWORD count; SID_AND_ATTRIBUTES groups[] }.
  static IntPtr LogonSid(IntPtr token) {
    int needed;
    GetTokenInformation(token, 28, IntPtr.Zero, 0, out needed);
    if (needed <= 0) return IntPtr.Zero;
    var buf = Marshal.AllocHGlobal(needed);
    if (!GetTokenInformation(token, 28, buf, needed, out needed) || Marshal.ReadInt32(buf) < 1) return IntPtr.Zero;
    // The array starts after the count, aligned to a pointer.
    return Marshal.ReadIntPtr(buf, IntPtr.Size);
  }

  static int Run(string[] argv, int start, SecurityIdentifier sid) {
    IntPtr token;
    // DUPLICATE | QUERY | ASSIGN_PRIMARY | ADJUST_DEFAULT | ADJUST_SESSIONID
    if (!OpenProcessToken(GetCurrentProcess(), 0x2 | 0x8 | 0x1 | 0x80 | 0x100, out token))
      throw new Exception("OpenProcessToken failed: " + Marshal.GetLastWin32Error());
    var everyone = new SecurityIdentifier(WellKnownSidType.WorldSid, null);
    var restrictList = new List<SID_AND_ATTRIBUTES> {
      new SID_AND_ATTRIBUTES { Sid = SidPtr(sid) },
      new SID_AND_ATTRIBUTES { Sid = SidPtr(everyone) },
    };
    // The window station and desktop are only granted to the logon session's
    // SID; without it console programs fail to initialise (0xC0000142).
    var logon = LogonSid(token);
    if (logon != IntPtr.Zero) restrictList.Add(new SID_AND_ATTRIBUTES { Sid = logon });
    var restrict = restrictList.ToArray();
    IntPtr restricted;
    // DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED
    if (!CreateRestrictedToken(token, 0x1 | 0x8, 0, IntPtr.Zero, 0, IntPtr.Zero, (uint)restrict.Length, restrict, out restricted))
      throw new Exception("CreateRestrictedToken failed: " + new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()).Message);

    // Objects the command creates (pipes, events) must stay writable for it,
    // so the sandbox SID goes into the token's default DACL.
    var acl = new RawAcl(2, 3);
    var user = WindowsIdentity.GetCurrent().User;
    var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
    int n = 0;
    foreach (var s in new[] { user, system, sid })
      acl.InsertAce(n++, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 0x10000000, s, false, null));
    var aclBytes = new byte[acl.BinaryLength];
    acl.GetBinaryForm(aclBytes, 0);
    var aclPtr = Marshal.AllocHGlobal(aclBytes.Length);
    Marshal.Copy(aclBytes, 0, aclPtr, aclBytes.Length);
    var dacl = new TOKEN_DEFAULT_DACL { DefaultDacl = aclPtr };
    var daclPtr = Marshal.AllocHGlobal(Marshal.SizeOf(dacl));
    Marshal.StructureToPtr(dacl, daclPtr, false);
    if (!SetTokenInformation(restricted, 6, daclPtr, Marshal.SizeOf(dacl)))
      throw new Exception("SetTokenInformation failed: " + Marshal.GetLastWin32Error());

    var si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(si);
    si.dwFlags = 0x100; // STARTF_USESTDHANDLES
    si.hStdInput = GetStdHandle(-10);
    si.hStdOutput = GetStdHandle(-11);
    si.hStdError = GetStdHandle(-12);
    PROCESS_INFORMATION pi;
    var cmd = new StringBuilder(CommandLine(argv, start));
    // CREATE_SUSPENDED
    if (!CreateProcessAsUser(restricted, null, cmd, IntPtr.Zero, IntPtr.Zero, true, 0x4, IntPtr.Zero,
        Environment.CurrentDirectory, ref si, out pi))
      throw new Exception("CreateProcessAsUser failed: " + new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()).Message);
    ResumeThread(pi.hThread);
    WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
    uint code;
    GetExitCodeProcess(pi.hProcess, out code);
    if (code >= 0xC0000000) Console.Error.WriteLine("aitech-sandbox: process failed with 0x" + code.ToString("X8"));
    return (int)code;
  }

  // The inverse of CommandLineToArgvW.
  static string CommandLine(string[] argv, int start) {
    var sb = new StringBuilder();
    for (int i = start; i < argv.Length; i++) {
      if (i > start) sb.Append(' ');
      var a = argv[i];
      if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) { sb.Append(a); continue; }
      sb.Append('"');
      int slashes = 0;
      foreach (var c in a) {
        if (c == '\\') { slashes++; continue; }
        if (c == '"') sb.Append('\\', slashes * 2 + 1);
        else sb.Append('\\', slashes);
        slashes = 0;
        sb.Append(c);
      }
      sb.Append('\\', slashes * 2);
      sb.Append('"');
    }
    return sb.ToString();
  }
}
`

function compiler(): string | null {
  const root = process.env.WINDIR ?? 'C:\\Windows'
  for (const fw of ['Framework64', 'Framework']) {
    const csc = join(root, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe')
    if (existsSync(csc)) return csc
  }
  return null
}

let launcher: string | null | undefined

/** Path of the compiled launcher, building it on first use; null if impossible. */
export function windowsLauncher(): string | null {
  if (launcher !== undefined) return launcher
  launcher = null
  const csc = compiler()
  if (!csc) return null
  const hash = createHash('sha256').update(LAUNCHER).digest('hex').slice(0, 12)
  const dir = join(process.env.LOCALAPPDATA ?? tmpdir(), 'aitech', 'sandbox')
  const exe = join(dir, `aitech-sandbox-${hash}.exe`)
  if (!existsSync(exe)) {
    mkdirSync(dir, { recursive: true })
    const src = join(dir, `aitech-sandbox-${hash}.cs`)
    writeFileSync(src, LAUNCHER)
    try {
      execFileSync(csc, ['/nologo', '/optimize', '/target:exe', `/out:${exe}`, src], {
        windowsHide: true,
        timeout: 60_000,
        stdio: 'pipe',
      })
    } catch {
      return null
    }
  }
  launcher = exe
  return exe
}

/** Directories (under the user profile) where package managers keep caches. */
function cacheDirs(env: NodeJS.ProcessEnv): string[] {
  const home = env.USERPROFILE ?? homedir()
  const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  return [
    join(local, 'npm-cache'),
    join(local, 'pnpm-cache'),
    join(local, 'pnpm'),
    join(local, 'Yarn'),
    join(local, 'pip'),
    join(local, 'Temp'),
    join(home, '.cache'),
    join(home, '.cargo', 'registry'),
    join(home, '.cargo', 'git'),
    join(home, 'go', 'pkg'),
    join(home, '.gradle'),
    join(home, '.m2'),
    join(home, '.nuget', 'packages'),
  ]
}

export function windowsSandboxSpawn(
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): { file: string; args: string[] } {
  const exe = windowsLauncher()
  if (!exe) throw new Error('Windows sandbox is unavailable (C# compiler not found)')
  const writable = [opts.cwd, tmpdir(), ...cacheDirs(opts.env)]
  const denied = [join(opts.cwd, '.git', 'hooks'), join(opts.cwd, '.git', 'config')]
  return {
    file: exe,
    args: [
      ...writable.flatMap((d) => ['--write', d]),
      ...denied.flatMap((d) => ['--deny-write', d]),
      '--',
      file,
      ...args,
    ],
  }
}

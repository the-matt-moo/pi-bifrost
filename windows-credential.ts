import { execFile } from "node:child_process";

const CREDENTIAL_SCRIPT = String.raw`
$source = @'
using System;
using System.Runtime.InteropServices;

public static class BifrostCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Credential {
    public UInt32 Flags;
    public UInt32 Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }

  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, UInt32 type, UInt32 reserved, out IntPtr credential);

  [DllImport("advapi32.dll", SetLastError = true)]
  private static extern void CredFree(IntPtr credential);

  public static string Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, 1, 0, out pointer)) {
      if (Marshal.GetLastWin32Error() == 1168) return null;
      throw new InvalidOperationException("Credential Manager read failed.");
    }

    try {
      Credential credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      return credential.CredentialBlobSize == 0
        ? ""
        : Marshal.PtrToStringUni(credential.CredentialBlob, (int)credential.CredentialBlobSize / 2);
    }
    finally {
      CredFree(pointer);
    }
  }
}
'@
Add-Type -TypeDefinition $source
$value = [BifrostCredential]::Read($env:PI_BIFROST_CREDENTIAL_TARGET)
if ($null -eq $value) { exit 3 }
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)))
`;

const encodedScript = Buffer.from(CREDENTIAL_SCRIPT, "utf16le").toString("base64");
const cache = new Map<string, string>();

/** Read a generic credential without putting its secret in command arguments or logs. */
export async function readWindowsCredential(target: string): Promise<string | undefined> {
  if (process.platform !== "win32" || !target.trim()) return undefined;
  const cached = cache.get(target);
  if (cached !== undefined) return cached;

  const encoded = await new Promise<string | undefined>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
      {
        env: {
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          ComSpec: process.env.ComSpec,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          PI_BIFROST_CREDENTIAL_TARGET: target,
        },
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 16 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) {
          if ((error as NodeJS.ErrnoException & { code?: number }).code === 3) resolve(undefined);
          else reject(new Error(`Unable to read Windows credential "${target}".`));
          return;
        }
        resolve(stdout.trim() || undefined);
      },
    );
  });

  if (!encoded) return undefined;
  const value = Buffer.from(encoded, "base64").toString("utf8");
  cache.set(target, value);
  return value;
}

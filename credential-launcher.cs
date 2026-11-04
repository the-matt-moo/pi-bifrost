// GUI-subsystem launcher (PE subsystem 2) for the credential read. Runs system PowerShell with
// the arguments given by Bifrost, with no console window; relays stdout/stderr and the exit code.
using System;
using System.Diagnostics;

class CredentialLauncher
{
    static int Main(string[] args)
    {
        try
        {
            string ps = System.IO.Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.System),
                "WindowsPowerShell", "v1.0", "powershell.exe");

            var psi = new ProcessStartInfo
            {
                FileName = ps,
                // Arguments are quoted individually so the encoded command survives intact.
                Arguments = string.Join(" ", Array.ConvertAll(args, a => "\"" + a.Replace("\"", "\\\"") + "\"")),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

            using (Process proc = Process.Start(psi))
            {
                var stdout = proc.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                var stderr = proc.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
                proc.WaitForExit();
                stdout.Wait();
                stderr.Wait();
                return proc.ExitCode;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("CredentialLauncher: " + ex.Message);
            return 1;
        }
    }
}

param([ValidateSet('encrypt', 'decrypt')][string]$Mode)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Security
$inputText = [Console]::In.ReadToEnd()
$entropy = [Text.Encoding]::UTF8.GetBytes('CodexWeChatQuestion-v1')
if ($Mode -eq 'encrypt') {
    $bytes = [Text.Encoding]::UTF8.GetBytes($inputText)
    $protectedBytes = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Convert]::ToBase64String($protectedBytes))
} else {
    $bytes = [Convert]::FromBase64String($inputText.Trim())
    $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plainBytes))
}

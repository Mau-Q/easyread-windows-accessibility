param(
 [Parameter(Mandatory=$true)][string]$Nvda,
 [Parameter(Mandatory=$true)][string]$Config,
 [Parameter(Mandatory=$true)][string]$PrivateLog,
 [string]$Title='双栏无障碍',
 [ValidateRange(5,55)][int]$Seconds=30
)
# Run only in an isolated desktop test session. The raw debug log is PRIVATE:
# NVDA can log unrelated foreground text. Never stage it in the repository.
$ErrorActionPreference='Stop'
if(Get-Process nvda -ErrorAction SilentlyContinue){throw 'Quit the existing NVDA instance before this isolated test'}
if(!$env:EASYREAD_CDP){throw 'Set EASYREAD_CDP to the explicitly enabled native test endpoint'}
New-Item -ItemType Directory -Force -Path $Config | Out-Null
if(!(Test-Path -LiteralPath (Join-Path $Config 'nvda.ini'))){
 @"
[general]
 language = zh_CN
 showWelcomeDialogAtStartup = False
[speech]
 synth = oneCore
[update]
 autoCheck = False
 startupNotification = False
"@ | Set-Content -LiteralPath (Join-Path $Config 'nvda.ini') -Encoding UTF8
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EasyReadSpeechKeys {
 [DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]public static extern void keybd_event(byte v,byte s,uint f,UIntPtr e);
 public static void Key(byte v,bool up){uint extended=(v==0x24||v==0x28||v==0x2D)?1u:0u;keybd_event(v,0,(up?2u:0u)|extended,UIntPtr.Zero);}
}
'@
$reader=Start-Process -FilePath $Nvda -ArgumentList @('-c',('"'+$Config+'"'),'-f',('"'+$PrivateLog+'"'),'--debug-logging','--disable-addons','--minimal') -WindowStyle Hidden -PassThru
try {
 Start-Sleep -Seconds 4
 & node (Join-Path $PSScriptRoot 'focus_native_pdf.cjs') $Title
 if($LASTEXITCODE -ne 0){throw 'Could not focus native PDF'}
 $app=Get-Process easyread-desktop
 if(![EasyReadSpeechKeys]::SetForegroundWindow($app.MainWindowHandle)){throw 'Could not foreground native app'}
 if([EasyReadSpeechKeys]::GetForegroundWindow() -ne $app.MainWindowHandle){throw 'Native app is not foreground'}
 [EasyReadSpeechKeys]::Key(0x11,$false);[EasyReadSpeechKeys]::Key(0x24,$false);[EasyReadSpeechKeys]::Key(0x24,$true);[EasyReadSpeechKeys]::Key(0x11,$true)
 Start-Sleep -Milliseconds 500
 [EasyReadSpeechKeys]::Key(0x2D,$false);[EasyReadSpeechKeys]::Key(0x28,$false);[EasyReadSpeechKeys]::Key(0x28,$true);[EasyReadSpeechKeys]::Key(0x2D,$true)
 Start-Sleep -Seconds $Seconds
 [EasyReadSpeechKeys]::Key(0x11,$false);[EasyReadSpeechKeys]::Key(0x11,$true)
 Write-Output 'Actual foreground native window: Ctrl+Home, NVDA+Down, then Ctrl to stop'
} finally {& $Nvda -q}

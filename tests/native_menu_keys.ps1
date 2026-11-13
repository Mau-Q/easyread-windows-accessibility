param([switch]$Quit,[switch]$ExpectConfirmation)
# Actual OS keyboard test, only for the isolated EasyRead test instance.
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class EasyReadNativeKeys {
 [StructLayout(LayoutKind.Sequential)]public struct K {public ushort vk,scan;public uint flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Sequential)]public struct M {public int x,y;public uint data,flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Explicit)]public struct U {[FieldOffset(0)]public K key;[FieldOffset(0)]public M mouse;}
 [StructLayout(LayoutKind.Sequential)]public struct I {public uint type;public U data;}
 [StructLayout(LayoutKind.Sequential)]public struct R {public int l,t,r,b;}
 [StructLayout(LayoutKind.Sequential)]public struct G {public int size;public uint flags;public IntPtr active,focus,capture,menu,move,caret;public R rect;}
 [DllImport("user32.dll",SetLastError=true)]static extern uint SendInput(uint count,I[] inputs,int size);
 [DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")]public static extern bool GetGUIThreadInfo(uint t,ref G info);
 [DllImport("user32.dll",SetLastError=true)]public static extern IntPtr OpenInputDesktop(uint f,bool inherit,uint access);
 [DllImport("user32.dll")]public static extern bool CloseDesktop(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern bool GetUserObjectInformation(IntPtr h,int i,StringBuilder text,int size,out int needed);
 public static void Key(ushort key,bool up){var input=new I();input.type=1;input.data.key.vk=key;input.data.key.flags=up?2u:0u;if(SendInput(1,new[]{input},Marshal.SizeOf(typeof(I)))!=1)throw new Exception("OS rejected input (secure desktop, UAC, or integrity boundary)");}
}
'@
$desktop=[EasyReadNativeKeys]::OpenInputDesktop(0,$false,1)
if($desktop -eq [IntPtr]::Zero){throw 'Input desktop unavailable: finish or cancel the Windows system prompt first'}
try{$name=[Text.StringBuilder]::new(256);[int]$needed=0;[void][EasyReadNativeKeys]::GetUserObjectInformation($desktop,2,$name,512,[ref]$needed);if($name.ToString() -ne 'Default'){throw 'Interactive desktop is unavailable'}}finally{[void][EasyReadNativeKeys]::CloseDesktop($desktop)}
$app=Get-Process easyread-desktop
[void][EasyReadNativeKeys]::SetForegroundWindow($app.MainWindowHandle)
if([EasyReadNativeKeys]::GetForegroundWindow() -ne $app.MainWindowHandle){throw 'Task app is not foreground'}
if($Quit){
 [EasyReadNativeKeys]::Key(0x11,$false)
 try{Start-Sleep -Milliseconds 80;[EasyReadNativeKeys]::Key(0x51,$false);Start-Sleep -Milliseconds 80;[EasyReadNativeKeys]::Key(0x51,$true)}finally{[EasyReadNativeKeys]::Key(0x11,$true)}
 if($ExpectConfirmation){
  Start-Sleep -Milliseconds 300
  Add-Type -AssemblyName UIAutomationClient
  $root=[System.Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
  $dialog=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'退出 EasyRead')))
  if(!$dialog){throw 'Expected native quit confirmation'}
  Write-Output 'Actual Ctrl+Q reached the native unsaved-work confirmation'
  return
 }
 if(!$app.WaitForExit(10000)){throw 'Ctrl+Q did not exit; inspect any native quit confirmation'}
 Write-Output 'Actual SendInput Ctrl+Q exited the native application'
}else{
 [EasyReadNativeKeys]::Key(0x79,$false);[EasyReadNativeKeys]::Key(0x79,$true)
 Start-Sleep -Milliseconds 200
 [uint32]$owner=0;$thread=[EasyReadNativeKeys]::GetWindowThreadProcessId($app.MainWindowHandle,[ref]$owner)
 $info=[EasyReadNativeKeys+G]::new();$info.size=[Runtime.InteropServices.Marshal]::SizeOf($info)
 [void][EasyReadNativeKeys]::GetGUIThreadInfo($thread,[ref]$info)
 Write-Output "F10 native menu mode=$($info.flags) owner=$($info.menu)"
 [EasyReadNativeKeys]::Key(0x1B,$false);[EasyReadNativeKeys]::Key(0x1B,$true)
 if(!$info.menu -and !($info.flags -band 4)){throw 'F10 did not enter native menu mode'}
}

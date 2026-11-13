param([Parameter(Mandatory=$true)][string]$Sample,[switch]$Save)
# Run with Windows PowerShell 5.1 while the task-owned Open dialog is visible.
# Sends actual Unicode keyboard input; does not inject an HTML file list.
$ErrorActionPreference='Stop'
if($Save){
 if(Test-Path -LiteralPath $Sample){throw 'Use a fresh output filename; never overwrite an existing file'}
 $samplePath=Join-Path (Resolve-Path -LiteralPath (Split-Path -Parent $Sample)).Path (Split-Path -Leaf $Sample)
} else {$samplePath=(Resolve-Path -LiteralPath $Sample).Path}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EasyReadPickerInput {
 [StructLayout(LayoutKind.Sequential)] public struct K {public ushort vk,scan;public uint flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Sequential)] public struct M {public int x,y;public uint data,flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Explicit)] public struct U {[FieldOffset(0)]public K key;[FieldOffset(0)]public M mouse;}
 [StructLayout(LayoutKind.Sequential)] public struct I {public uint type;public U data;}
 [DllImport("user32.dll",SetLastError=true)]public static extern uint SendInput(uint count,I[] inputs,int size);
 [DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("kernel32.dll")]public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")]public static extern bool AttachThreadInput(uint a,uint b,bool attach);
 [DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]public static extern IntPtr SetFocus(IntPtr h);
 [DllImport("user32.dll")]public static extern void keybd_event(byte vk,byte scan,uint flags,UIntPtr extra);
 public static void Type(string text){
  I[] inputs=new I[text.Length*2];
  for(int n=0;n<text.Length;n++){inputs[n*2].type=1;inputs[n*2].data.key.scan=text[n];inputs[n*2].data.key.flags=4;inputs[n*2+1]=inputs[n*2];inputs[n*2+1].data.key.flags=6;}
  if(SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(I)))!=inputs.Length)throw new Exception("Keyboard input rejected");
 }
}
'@
$app=Get-Process easyread-desktop
$root=[System.Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
$dialogTitle=if($Save){'另存为'}else{'打开'}
$condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$dialogTitle)
$dialog=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)
if(!$dialog){
 $top=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$app.Id)))
 $dialog=$top|Where-Object {$_.Current.Name -eq $dialogTitle}|Select-Object -First 1
}
if(!$dialog){throw 'No task-owned native file dialog'}
$filenameId=if($Save){'1001'}else{'1148'}
$items=$dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,$filenameId)))
$edit=$items|Where-Object {$_.Current.ClassName -eq 'Edit'}|Select-Object -First 1
if(!$edit){throw 'Native filename input not found'}
[uint32]$process=0
$targetThread=[EasyReadPickerInput]::GetWindowThreadProcessId([IntPtr]$dialog.Current.NativeWindowHandle,[ref]$process)
$thread=[EasyReadPickerInput]::GetCurrentThreadId()
$attached=[EasyReadPickerInput]::AttachThreadInput($thread,$targetThread,$true)
try {
 [void][EasyReadPickerInput]::SetForegroundWindow([IntPtr]$dialog.Current.NativeWindowHandle)
 [void][EasyReadPickerInput]::SetFocus([IntPtr]$edit.Current.NativeWindowHandle)
 if([EasyReadPickerInput]::GetForegroundWindow() -ne [IntPtr]$dialog.Current.NativeWindowHandle){throw 'Picker is not foreground'}
 [EasyReadPickerInput]::keybd_event(0x11,0,0,[UIntPtr]::Zero)
 [EasyReadPickerInput]::keybd_event(0x41,0,0,[UIntPtr]::Zero)
 [EasyReadPickerInput]::keybd_event(0x41,0,2,[UIntPtr]::Zero)
 [EasyReadPickerInput]::keybd_event(0x11,0,2,[UIntPtr]::Zero)
 [EasyReadPickerInput]::Type($samplePath)
 [EasyReadPickerInput]::keybd_event(0x0D,0x1C,0,[UIntPtr]::Zero)
 [EasyReadPickerInput]::keybd_event(0x0D,0x1C,2,[UIntPtr]::Zero)
 Write-Output 'Actual native picker: Unicode path typed by SendInput and Enter pressed'
} finally {if($attached){[void][EasyReadPickerInput]::AttachThreadInput($thread,$targetThread,$false)}}

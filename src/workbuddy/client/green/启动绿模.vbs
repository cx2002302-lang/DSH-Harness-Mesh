' 无窗口启动 guardian(pythonw 模式:任何窗口都不弹)
' 用法:shell:startup 放本文件快捷方式=开机无窗口自启;或资源管理器双击
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("Wscript.Shell")
' pythonw.exe 无控制台;guardian.py 内部已做无 stdout 保护
sh.CurrentDirectory = here
sh.Run "pythonw.exe """ & here & "\guardian.py""", 0, False

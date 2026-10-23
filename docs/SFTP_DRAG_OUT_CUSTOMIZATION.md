# SFTP 拖到电脑目录：实现与移植记录

日期：2026-10-23，定制版本 `6.6.6`。源码已合入官方提交 `238fe45ee`（初始定制基线为 `1956513a5ee6c904ae400df0e86d5ee9dda1e458`），保留当前背景图、禁止更新和布局修复。此前 EXE 对应合并前源码，本次冲突解决不代表已重新打包。

## 当前行为

在终端右侧 SFTP 面板或完整 SFTP 页面，选中文件或文件夹，按住鼠标拖到桌面或资源管理器的文件列表区域。目标提示框只显示“下载到 + 目录路径”；在目标目录松开鼠标后才启动软件原有的 SFTP 下载。支持多选和递归文件夹。传输中心继续负责进度、重名冲突、暂停、重试和取消。

这版已替换旧的临时副本设计。拖动期间不读取远程文件内容、不下载到临时目录，也不用 Electron `startDrag()` 复制已下载的文件；慢连接只需拖动一次。桌面路径通过 Windows Known Folder API 获取，兼容桌面重定向。松开时重新识别，不能沿用曾经悬停过的目录。

支持 Windows 桌面空白处、桌面普通文件夹图标、资源管理器当前目录的文件列表空白处和其中的文件夹。松开时指向普通文件，则下载到该文件所在目录，文件本身不作为覆盖或打开目标；指向文件夹则下载到该文件夹内。地址栏、导航树、预览窗格、回收站等虚拟位置和其他应用不显示目标提示，松开不下载。需要先在资源管理器打开目标目录；悬停不会自动展开目录或切换窗口。按 Esc、关闭来源面板或开始新拖动取消手势。软件内始终使用官方原有拖动逻辑，不需要 Shift 切换模式。macOS/Linux 保留原来的软件内拖动。

外部提示卡使用圆角、半透明底色、细边框和轻阴影，只保留一行“下载到 + 目录路径”，不显示源文件名、数量、图标或单独的目标名称。路径过长时使用路径省略显示。鼠标位置的浏览器拖动预览继续显示纯文件名，与目标提示卡分开；HTML payload、拖动操作和软件内接收逻辑保持官方实现。

## 电脑文件拖入终端或 SFTP

拖入方向保留官方实现。`components/terminal/hooks/useTerminalDragDrop.ts` 接收系统 `Files`：本地终端插入带引号的本地路径，SSH 终端按原有规则使用 ZMODEM 上传或回退 SFTP，并解析当前远程工作目录。`components/sftp/hooks/useSftpPaneDragAndSelect.ts` 与 `SftpPaneTreeView.tsx` 将电脑文件交给已有 `onUploadExternalFiles`；目录条目落点传入该目录，空白处或普通文件行落点使用当前目录。`useSftpExternalOperations.uploadExternalFiles` 在事件结束前同步捕获 DataTransfer，后续使用原有上传和冲突处理。

### Windows 显示禁止且松开完全无反应

2026-10-23 在本机查到已安装的 `D:\APP\Netcatty\Netcatty.exe` 为官方 `1.1.85`，并存在以下全用户兼容性配置：

```text
HKEY_LOCAL_MACHINE\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers
Value name: D:\APP\Netcatty\Netcatty.exe
Value data: ~ RUNASADMIN
```

该设置强制管理员启动；普通权限的 Explorer 无法将 OLE 文件拖入较高权限窗口，系统会在 React 收到事件前阻止操作。添加更多 `onDrop` 或重新实现 SFTP 上传无法解决这一权限隔离。不要为解决此问题关闭 UAC。

先保存工作并退出当前程序，再从普通权限的资源管理器启动新版。新增 `release/Start-Netcatty-6.6.6.cmd`，与 `Netcatty-6.6.6-portable-win-x64.exe` 放在同一目录，双击启动；不要对启动入口使用“以管理员身份运行”。文件完整内容如下：

```bat
@echo off
setlocal
set "__COMPAT_LAYER=RunAsInvoker"
if not exist "%~dp0Netcatty-6.6.6-portable-win-x64.exe" (
  echo Keep this launcher beside Netcatty-6.6.6-portable-win-x64.exe.
  pause
  exit /b 1
)
start "" "%~dp0Netcatty-6.6.6-portable-win-x64.exe" %*
endlocal
```

`RunAsInvoker` 仅作用于该次启动，不写注册表；调用者本身必须是普通权限。若通过原 EXE 启动，可在 EXE 属性 → 兼容性 → 更改所有用户的设置中，取消“以管理员身份运行此程序”。已经运行的管理员实例仍须退出后重新启动；没有擅自结束现有 SSH 会话。本次只新增启动入口和说明，没有修改上传协议或重新生成相同应用代码的 EXE。

本轮验证：用真实资源管理器鼠标拖入 6.6.6 安装包对应程序的本地终端，成功插入完整带引号路径；拖入右侧 SFTP 的隔离本地目录，收到 `Files` 并写入内容一致的文件。另将实际免安装 EXE 与该 CMD 复制到隔离临时目录，通过 CMD 启动后再次完成 SFTP 拖入。终端拖入、工作目录解析及 SFTP 拖动交互的 34 项定向测试通过。真实窗口测试目标均为临时本地目录；本轮未声称完成新的远程 SSH 服务器上传验收。

## 修改文件与职责

| 文件 | 职责 |
| --- | --- |
| `domain/sftpExternalDownload.ts` | 校验下载根名称，拒绝 Windows 保留名、控制字符、路径分隔符等；保留合法 Unicode 名称 |
| `application/state/sftp/localFileDrag.ts` | 保留官方本地拖动和远程 HTML 拖动；附加外部目标观察器，按 requestId 隔离取消、面板卸载与新手势 |
| `application/state/sftp/useSftpFileDrag.ts` | 固定来源会话/编码；得到目标后校验远程条目，再调用既有 `downloadToLocal` |
| `infrastructure/services/sftpFileDragBridge.ts` | typed bridge 适配器，提供目标检测、纯文字拖动预览及既有 stat/list 调用 |
| `electron/bridges/sftpFileDragBridge.cjs` | 验证主 frame/窗口/物理手势，启动原生辅助程序，校验目标路径/目录，处理取消、超时、窗口销毁 |
| `electron/bridges/sftpDropTarget/NetcattySftpDropTarget.cpp` | Windows Shell + UI Automation 命中检测、跟随鼠标的反馈层、物理松开/Esc 检测；仅报告目标，不做文件传输 |
| `electron/bridges/localFileDragBridge.cjs` | 返回已有主进程物理手势 tracker，供目标检测复用 |
| `electron/main/registerBridges.cjs` | 注册目标检测服务，传入共用 tracker，不增加独立 SFTP worker 下载路线 |
| `electron/preload/api.cjs`、`types/global/netcatty-bridge-sftp.d.ts` | `startSftpFileDrag` / `cancelSftpFileDrag` IPC 与类型，Windows 以外不暴露目标检测入口 |
| `components/sftp/hooks/useSftpViewPaneCallbacks.ts`、Context/Pane/Tree/拖动 hooks | 接入应用层动作，侧栏和完整页面共用；排队后提示目标路径 |
| `application/i18n/locales/*/vault.ts` | 五种现有语言的手势提示、有效/无效目标与排队文案 |
| `scripts/build-sftp-drop-target.cjs`、`scripts/beforePackCursorSdk.cjs` | Windows 打包前编译相应架构的原生程序，检查 PE 架构；失败即停止打包 |
| `electron-builder.config.cjs`、`.gitignore`、`package.json` | 原生程序置于 resources/sftpDropTarget，排除 ASAR/build 缓存；新增编译脚本 |

## 执行顺序与关键代码

preload 入口只接收手势 ID 和界面文字，不传密码或远程文件内容：

```js
startSftpFileDrag: process.platform === 'win32'
  ? payload => ipcRenderer.invoke('netcatty:sftp:drag-start', payload)
  : undefined,
cancelSftpFileDrag: requestId =>
  ipcRenderer.send('netcatty:sftp:drag-cancel', { requestId }),
```

返回类型：

```ts
startSftpFileDrag?({ requestId, count, fileNames, copyLabel, invalidLabel, selectionLabel }):
  Promise<{ status: 'cancelled' } | { status: 'dropped'; directory: string }>;
```

主进程启动程序时使用 `shell: false`，参数独立传入，限定输出大小和运行时间。只接受对应窗口主 frame、有物理鼠标手势的请求。辅助程序只识别真正的 Shell 文件视图，拒绝不明确的命中。桌面使用 `SHGetKnownFolderPath(FOLDERID_Desktop)`；Explorer 通过 `IShellWindows → IShellBrowser → IFolderView → IShellFolder` 取得当前视图目录，UI Automation 判定鼠标正下方的文件夹，避免把已选中条目误当悬停条目。

2026-10-23 普通文件落点补充：解析条目的绝对 PIDL，并用 `GetFileAttributesW()` 区分真实目录和文件。文件使用 `ILRemoveLastID()` 取得父 PIDL，再解析为真实目录；不会执行文件、跟随快捷方式或把文件路径当目录。隐藏扩展名导致 `ParseDisplayName()` 失败时，枚举当前 Shell 文件夹的 `SIGDN_NORMALDISPLAY` 查找唯一匹配，不猜测扩展名；歧义或失效条目仍拒绝。

显示补充：C++ 使用 GDI+ 绘制 `PixelFormat32bppPARGB` 位图，经 `UpdateLayeredWindow()` 提交逐像素 alpha。卡片逻辑尺寸为 420×48，四周额外留 12 像素用于阴影；绘制和工作区位置计算共用尺寸常量。底色 alpha 为 190/255，文字单独绘制，保持清晰。“下载到”使用现有本地化 `copyLabel`，测量宽度后给右侧目录路径留出空间。删除旧文件名区、数量、分隔线和目标名称；没有有效路径时隐藏卡片。兼容旧的 7/9 参数启动接口，辅助程序不再解析文件名参数；鼠标文件名预览仍由 renderer 负责。按所在显示器 DPI 缩放并限制在工作区内。编译链接包含 `gdiplus.lib`。

本次精简的核心绘制代码（完整文件见联合补丁）：

```cpp
Font detailFont(&family, 14, FontStyleRegular, UnitPixel);
StringFormat format;
format.SetFormatFlags(StringFormatFlagsNoWrap);
format.SetLineAlignment(StringAlignmentCenter);
SolidBrush labelBrush(Color(255, 145, 233, 200));
RectF labelBounds;
graphics.MeasureString(copyLabel.c_str(), -1, &detailFont, PointF(0, 0), &labelBounds);
const float labelWidth = std::min(labelBounds.Width, 160.0f);
graphics.DrawString(copyLabel.c_str(), -1, &detailFont,
  RectF(22, 4, labelWidth, cardHeight), &format, &labelBrush);
format.SetTrimming(StringTrimmingEllipsisPath);
SolidBrush pathBrush(Color(255, 247, 250, 255));
graphics.DrawString(currentTarget.path.c_str(), -1, &detailFont,
  RectF(22 + labelWidth + 6, 4, 382 - labelWidth, cardHeight), &format, &pathBrush);
```

拖动光标补充：外部拖动使用纯文件名的 HTML drag image，热点对齐鼠标位置；原生观察器暂时附着来源窗口的输入队列，用配对的 `ShowCursor()` 隐藏 OLE 箭头/禁止符号，拖回软件或结束时恢复。不调用 `SetSystemCursor()`，不更换系统光标资源或用户方案。取消通过标准输入通知辅助程序退出，先恢复光标再结束；若辅助程序异常退出或超时强制终止，主进程启动 `--restore-cursor` 恢复分支。

普通远程拖动先按官方代码设置 `effectAllowed = 'copyMove'`、`text/plain` 并调用 `onRemoteDrag(sources, side)`，不调用 `preventDefault()`。Shift 不再选择另一个模式。原生程序在鼠标位于来源窗口内时隐藏反馈、不解析 Shell 目标；离开软件后才显示电脑目录，回到软件后又隐藏。内部 drop 事件在原有 React 处理完成后取消外部观察器，内部传输仍由官方代码负责。Windows 文件名限制移到确认外部落点后执行，避免影响服务器允许的名称。

反馈窗口使用 `WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW`，不抢焦点、不截获鼠标、不改变目标窗口。在每次物理松开时重新解析：

```cpp
if (!(GetAsyncKeyState(VK_LBUTTON) & 0x8000)) {
  GetCursorPos(&point);
  currentTarget = resolve(point, windows.Get(), automation.Get());
  dropped = !currentTarget.path.empty();
  break;
}
```

主进程再次检查目标为完整盘符/UNC 目录，拒绝设备路径、相对路径和已删除目录。成功返回后，应用 hook 才调用已有元数据解析，再通过原有下载方法提交：

```ts
const result = await sftpFileDragBridge.start({ requestId, count: sources.length,
  copyLabel: t('sftp.drag.copyTo'), invalidLabel: t('sftp.drag.invalidTarget'),
  selectionLabel: t('sftp.drag.selection', { count: sources.length }) });
if (result.status !== 'dropped' || !isCurrent()) return;
// 实际代码逐项检查 requestId、来源会话和编码，解析文件/链接/目录。
await sftpRef.current.downloadToLocal({
  fileName: source.name, sourcePath,
  targetPath: joinPath(result.directory, source.name),
  sftpId, connectionId, sourceHostId: connection.hostId,
  sourceHostLabel: connection.hostLabel, sourceEncoding: encoding,
  isDirectory: snapshot.isDirectory,
  totalBytes: snapshot.isDirectory ? undefined : snapshot.size,
});
```

根条目使用已有受限并发工具提交；下载后的生命周期归原有传输中心管理。手势取消只取消尚未提交的请求，不中止已经进入队列的传输。符号链接按现有普通下载的解析规则处理。主进程无需接入新的 SFTP I/O、临时缓存或重复实现传输限流；也不再修改 `transferBridge` 的取消导出。

## 构建与官方新版移植

Windows 本地开发需 MSVC C++17 和 Windows SDK：

```powershell
npm run build:sftp-drop-target
npm run test:sftp-file-drag:electron
npm run build
npm run pack:win-x64
```

打包前自动编译，安装版/免安装版均包含 `resources/sftpDropTarget/NetcattySftpDropTarget.exe`。输出缓存被忽略，不把本机 EXE 当源码提交。

移植顺序：先检查官方是否已有目标目录拖放实现，再对照纯名称校验、主进程服务/原生程序、preload/类型/适配器、应用 hook、共用 Pane/Tree UI 和五种语言逐段合并。保留官方已有的 `downloadToLocal`、传输中心和 worker 限流；保留背景透明表面标记。`localFileDrag` 不能退回预下载路径，也不能把 `startDrag()` 的返回理解为目标路径。

完整逐行代码收入 [背景定制文档源码附录](APP_BACKGROUND_CUSTOMIZATION.md) 与 [联合补丁](patches/netcatty-app-background-2026-10-22.patch)。联合补丁还包含背景、禁止更新和布局修复，移植时按本页职责表选择改动，不要把联合补丁当作仅 SFTP 的补丁。

## 验证记录

本次真实窗口测试使用隔离配置、真实 Windows 鼠标输入、资源管理器及本机 SSH/SFTP 测试服务，运行真实 `useSftpFileDrag → useSftpTransfers → transferBridge` 下载链路。验证鼠标按住时零文件读取/零排队、Esc 零传输，多选文件及文件夹内容一致，慢速文件松开一次即下载到目标。另用原生 probe 验证桌面真实路径、当前目录、文件夹行，并拒绝导航树和预览窗格。测试数据只写 Netcatty 专用临时目录。

34 项定向测试通过（含打包 hook）；背景真实 WebGL/DOM 测试通过。扩展 SFTP 回归执行 495 项：482 通过，1 跳过，5 失败，7 因待完成 Promise 被取消；失败涉及未修改的旧测试中的 Windows symlink 权限、源码正则断言以及恢复流程等待，不宣称全库测试通过。全库 TypeScript 检查也有既有错误；生产构建与安装版/免安装版打包成功；lint 为 0 错误、7 个既有警告。

原生定位支持本机可访问的标准桌面/Explorer 视图，不承诺第三方文件管理器、管理员级别窗口、虚拟目录或所有 Windows Shell 扩展。不同 DPI、Explorer 布局和系统版本仍需用户实际验收。

发布包另用隔离配置连接测试 SSH/SFTP 服务，验证打包程序真实拖动后返回正确目录并经既有传输引擎写入内容一致的文件。安装版对应的 win-unpacked 程序和免安装 EXE 的 worker 路径均通过。关键入口、preload、目标检测 bridge、更新策略及背景 bridge 从 ASAR 读取后与当前源码逐字节一致。EXE 校验值见 `release/SHA256SUMS.txt`。

打包注意：生成/归一化源码应在归档前完成，打包期间不要改动被打包的文件。文件长度在 ASAR 记录后变化会使后续偏移失效，可能启动成 Electron 默认界面。必须以最终 EXE 启动及实际传输验收，不能仅以构建命令退出成功作为验收。

最终 EXE 回归补充：非 worker 传输路径通过；背景、透明度、关闭回退、更新检查/下载/安装/重新启用拦截、本地终端输出及串口枚举通过。安装版对应程序在 4 倍 CPU 节流下切换右侧 SFTP/AI/历史并录制 137 帧；逐帧扫描终端和侧栏区域，未发现原图裸露色块或白块。源码真实渲染测试另覆盖 WebGL 和 DOM 回退。

2026-10-22 后续纠正：已取消“普通拖动用于外部、Shift 用于内部”的模式分流。真实 Windows HTML 拖动回归使用官方 `useSftpPaneDragAndSelect` 接收器，验证普通拖动可将原始来源交给另一 SFTP 面板，且不启动电脑下载；随后拖出到 Explorer 的多选/文件夹和慢文件下载、Esc 取消继续通过。软件内拖动规则保持官方实现，未增加跨面板传输协议或重新实现目录移动。

本轮最终验证：65 项定向测试通过；真实 WebGL/DOM 背景测试通过。重新生成的安装版对应程序和免安装 EXE 均通过外部落点识别与实际 SFTP 下载。免安装版另录制 106 帧检查分屏与侧栏切换，四次边缘像素检查均未发现右侧终端左缘的亮缝。生产构建、两种 EXE 打包成功；lint 为 0 错误、7 个既有警告。上述结果不代表全库 TypeScript 或全部 SFTP 历史测试通过。

2026-10-23 / 6.6.6 验证补充：本轮 41 项 SFTP、preload、更新拦截定向测试通过；修改文件 lint 通过，全库 lint 为 0 错误、7 个既有警告。真实 Windows 鼠标输入覆盖普通文件落点（原文件内容保持不变）、文件夹落点、隐藏扩展名、多选和慢文件、中文与 `&` 名称、Esc、拖出后返回软件继续官方跨面板拖动。通过原生 `GetCursorInfo()` 验证外部拖动隐藏系统箭头，结束或取消后恢复；保留三张实际提示卡截图用于检查圆角、透明度和文件名清晰度。下载均走真实测试 SSH/SFTP 服务和现有下载队列，拖动未松开时不读远程内容、不排队。

6.6.6 发布包复核：安装版对应 `win-unpacked/Netcatty.exe` 与免安装 EXE 均真实启动，应用返回版本 `6.6.6`；指向资源管理器已有普通文件松开后，下载内容与远端一致，目标原文件保持不变。ASAR 中的入口、注册、preload、SFTP bridge、背景 bridge 与更新策略均与源码逐字节一致；打包的原生目标识别程序与本轮编译结果一致。更新策略继续为禁用。EXE 文件名和校验值见 `release/SHA256SUMS.txt`。

2026-10-23 / 提示卡精简复核：按最终要求仅显示一行“下载到 + 目录路径”，保留半透明、圆角、边框和阴影。重新编译原生程序，真实 Windows 拖动测试通过，覆盖官方内部拖动、拖出再返回、Esc、松开前零传输、多选、慢文件、普通文件与文件夹落点、中文与 `&`、系统光标隐藏与恢复。重新生成 6.6.6 安装版和免安装版；两种包对应程序均真实启动并通过落点识别和 SFTP 下载，落点原文件保持不变。实际中文提示卡截图确认仅有“下载到”和路径，没有文件名列表、数量或单独目标名称。打包 helper 与本地编译二进制一致，关键 ASAR 文件与源码一致；本次只修改原生绘制，复用此前通过生产构建的 dist，未重新声称全库 lint/TypeScript/历史测试通过。同步更新联合补丁和 EXE SHA256。

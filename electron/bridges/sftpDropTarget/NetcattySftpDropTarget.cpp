#define UNICODE
#define _UNICODE
#define NOMINMAX
#include <windows.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <exdisp.h>
#include <servprov.h>
#include <uiautomation.h>
#include <wrl/client.h>
#include <gdiplus.h>
#include <string>
#include <iostream>
#include <algorithm>

using Microsoft::WRL::ComPtr;

// This helper observes a held mouse gesture, resolves only actual shell views,
// and reports a destination. It never creates, copies or downloads any file.
struct Target { std::wstring path, label, kind; };
std::wstring copyLabel;
Target currentTarget;
HWND overlay;
constexpr float feedbackCardWidth = 420;
constexpr float feedbackCardHeight = 48;
constexpr float feedbackPadding = 12;
bool probing = false;

// Hide the OLE arrow/no-drop cursor only in the source window's drag input
// queue. Never replace system cursor resources or alter the user's scheme.
class DragCursorVisibility {
  DWORD sourceThread;
  bool attached = false;
  int hidden = 0;
  HCURSOR previousCursor = nullptr;
public:
  explicit DragCursorVisibility(HWND owner) : sourceThread(GetWindowThreadProcessId(owner, nullptr)) {}
  void hide() {
    if (attached || !sourceThread) return;
    attached = AttachThreadInput(GetCurrentThreadId(), sourceThread, TRUE) != FALSE;
    if (!attached) return;
    previousCursor = GetCursor();
    int count;
    do { count = ShowCursor(FALSE); ++hidden; } while (count >= 0 && hidden < 16);
  }
  void restore(bool ending = false) {
    if (!attached) return;
    if (ending) {
      // OLE pairs its own ShowCursor calls when releasing mouse capture.
      // Wait for that pair before restoring our additional hide count.
      const auto until = GetTickCount64() + 500;
      GUITHREADINFO info{sizeof(GUITHREADINFO)};
      while (GetGUIThreadInfo(sourceThread, &info) && info.hwndCapture && GetTickCount64() < until) Sleep(10);
    }
    while (hidden > 0) { ShowCursor(TRUE); --hidden; }
    SetCursor(previousCursor ? previousCursor : LoadCursorW(nullptr, IDC_ARROW));
    AttachThreadInput(GetCurrentThreadId(), sourceThread, FALSE);
    attached = false;
  }
  ~DragCursorVisibility() { restore(); }
};

std::wstring className(HWND window) {
  wchar_t buffer[256]{};
  GetClassNameW(window, buffer, 256);
  return buffer;
}
bool directory(const std::wstring& value) {
  const DWORD attrs = GetFileAttributesW(value.c_str());
  return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY);
}
std::wstring displayName(const std::wstring& value) {
  SHFILEINFOW info{};
  if (SHGetFileInfoW(value.c_str(), 0, &info, sizeof(info), SHGFI_DISPLAYNAME)) return info.szDisplayName;
  return value;
}
std::wstring fromPidl(PCIDLIST_ABSOLUTE pidl) {
  PWSTR value = nullptr;
  if (FAILED(SHGetNameFromIDList(pidl, SIGDN_FILESYSPATH, &value))) return {};
  std::wstring result(value);
  CoTaskMemFree(value);
  return result;
}

// Return the item under the pointer, not the selected/focused shell item.
// An empty name means view background; inaccessible/ambiguous UI is rejected.
bool hitItem(IUIAutomation* automation, HWND view, POINT point, std::wstring& name) {
  if (!automation) return false;
  ComPtr<IUIAutomationElement> element;
  if (FAILED(automation->ElementFromPoint(point, &element)) || !element) return false;
  ComPtr<IUIAutomationTreeWalker> walker;
  if (FAILED(automation->get_RawViewWalker(&walker))) return false;
  for (int depth = 0; element && depth < 20; ++depth) {
    CONTROLTYPEID type = 0;
    element->get_CurrentControlType(&type);
    if (type == UIA_ListItemControlTypeId || type == UIA_DataItemControlTypeId) {
      BSTR text = nullptr;
      if (FAILED(element->get_CurrentName(&text)) || !text) return false;
      name.assign(text, SysStringLen(text));
      SysFreeString(text);
      return !name.empty();
    }
    UIA_HWND native = nullptr;
    element->get_CurrentNativeWindowHandle(&native);
    if (probing) std::cerr << "UIA type=" << type << " native=" << native << " view=" << view << std::endl;
    if (native == view || type == UIA_ListControlTypeId || type == UIA_DataGridControlTypeId) return true;
    ComPtr<IUIAutomationElement> parent;
    if (FAILED(walker->GetParentElement(element.Get(), &parent))) return false;
    element = parent;
  }
  return false;
}

// UI Automation exposes display names, which may omit a file extension.
// Fall back to Shell's own display names rather than guessing an extension.
PIDLIST_RELATIVE parseItem(IShellFolder* folder, PCIDLIST_ABSOLUTE root,
                          const std::wstring& name, SFGAOF& attributes) {
  PIDLIST_RELATIVE child = nullptr;
  std::wstring mutableName = name;
  if (SUCCEEDED(folder->ParseDisplayName(nullptr, nullptr, mutableName.data(), nullptr, &child, &attributes)) && child) return child;
  CoTaskMemFree(child);
  ComPtr<IEnumIDList> items;
  if (FAILED(folder->EnumObjects(nullptr, SHCONTF_FOLDERS | SHCONTF_NONFOLDERS | SHCONTF_INCLUDEHIDDEN, &items)) || !items) return nullptr;
  PIDLIST_RELATIVE match = nullptr;
  while (items->Next(1, &child, nullptr) == S_OK) {
    PIDLIST_ABSOLUTE absolute = ILCombine(root, child);
    PWSTR display = nullptr;
    const bool matches = absolute && SUCCEEDED(SHGetNameFromIDList(absolute, SIGDN_NORMALDISPLAY, &display))
      && display && name == display;
    CoTaskMemFree(display);
    CoTaskMemFree(absolute);
    if (matches) {
      if (match) { CoTaskMemFree(child); CoTaskMemFree(match); return nullptr; }
      match = child;
    } else CoTaskMemFree(child);
  }
  if (match) {
    attributes = SFGAO_FOLDER | SFGAO_FILESYSTEM;
    PCUITEMID_CHILD entry = match;
    if (FAILED(folder->GetAttributesOf(1, &entry, &attributes))) { CoTaskMemFree(match); return nullptr; }
  }
  return match;
}

Target resolveView(IShellFolder* folder, PCIDLIST_ABSOLUTE root, HWND view,
                   POINT point, IUIAutomation* automation, const std::wstring& background,
                   const wchar_t* kind) {
  RECT bounds{};
  GetWindowRect(view, &bounds);
  if (!PtInRect(&bounds, point)) return {};
  const HWND hit = WindowFromPoint(point);
  if (hit != view && !IsChild(view, hit)) return {};
  std::wstring name;
  if (!hitItem(automation, view, point, name)) return {};
  if (name.empty()) {
    if (!directory(background)) return {};
    return {background, displayName(background), kind};
  }
  SFGAOF attributes = SFGAO_FOLDER | SFGAO_FILESYSTEM;
  PIDLIST_RELATIVE child = parseItem(folder, root, name, attributes);
  if (!child) return {};
  PIDLIST_ABSOLUTE absolute = ILCombine(root, child);
  CoTaskMemFree(child);
  if (!absolute) return {};
  const std::wstring path = fromPidl(absolute);
  const DWORD fileAttributes = GetFileAttributesW(path.c_str());
  Target target;
  if ((attributes & SFGAO_FILESYSTEM) && fileAttributes != INVALID_FILE_ATTRIBUTES) {
    if (fileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
      target = {path, displayName(path), L"folder"};
    } else if (ILRemoveLastID(absolute)) {
      // A regular file is a landing point for its containing directory.
      // Resolve the parent PIDL instead of following shortcuts or parsing text.
      const std::wstring parent = fromPidl(absolute);
      if (directory(parent)) target = {parent, displayName(parent), kind};
    }
  }
  CoTaskMemFree(absolute);
  return target;
}

Target resolve(POINT point, IShellWindows* windows, IUIAutomation* automation) {
  const HWND at = WindowFromPoint(point);
  const HWND rootWindow = GetAncestor(at, GA_ROOT);
  const auto rootClass = className(rootWindow);
  if (probing) {
    for (HWND window = at; window; window = GetParent(window)) {
      std::wcerr << L"Window: " << className(window) << L" " << window << std::endl;
    }
  }
  if (rootClass == L"Progman" || rootClass == L"WorkerW") {
    HWND view = FindWindowExW(rootWindow, nullptr, L"SHELLDLL_DefView", nullptr);
    if (!view) return {};
    ComPtr<IShellFolder> folder;
    if (FAILED(SHGetDesktopFolder(&folder))) return {};
    PIDLIST_ABSOLUTE root = nullptr;
    PWSTR desktopPath = nullptr;
    SHGetSpecialFolderLocation(nullptr, CSIDL_DESKTOP, &root);
    SHGetKnownFolderPath(FOLDERID_Desktop, KF_FLAG_DEFAULT, nullptr, &desktopPath);
    Target target = resolveView(folder.Get(), root, view, point, automation,
                               desktopPath ? desktopPath : L"", L"desktop");
    CoTaskMemFree(root);
    CoTaskMemFree(desktopPath);
    return target;
  }
  if (rootClass != L"CabinetWClass" || !windows) return {};
  long count = 0;
  windows->get_Count(&count);
  for (long index = 0; index < count; ++index) {
    VARIANT item{};
    item.vt = VT_I4; item.lVal = index;
    ComPtr<IDispatch> dispatch;
    if (FAILED(windows->Item(item, &dispatch)) || !dispatch) continue;
    ComPtr<IWebBrowserApp> browser;
    if (FAILED(dispatch.As(&browser))) continue;
    SHANDLE_PTR handle = 0;
    browser->get_HWND(&handle);
    if (reinterpret_cast<HWND>(handle) != rootWindow) continue;
    ComPtr<IServiceProvider> services;
    ComPtr<IShellBrowser> shellBrowser;
    ComPtr<IShellView> shellView;
    ComPtr<IFolderView> folderView;
    ComPtr<IShellFolder> folder;
    ComPtr<IPersistFolder2> persist;
    if (FAILED(dispatch.As(&services)) ||
        FAILED(services->QueryService(SID_STopLevelBrowser, IID_PPV_ARGS(&shellBrowser))) ||
        FAILED(shellBrowser->QueryActiveShellView(&shellView)) ||
        FAILED(shellView.As(&folderView)) ||
        FAILED(folderView->GetFolder(IID_PPV_ARGS(&folder))) ||
        FAILED(folder.As(&persist))) continue;
    HWND view = nullptr;
    PIDLIST_ABSOLUTE root = nullptr;
    shellView->GetWindow(&view);
    if (FAILED(persist->GetCurFolder(&root))) continue;
    Target target = resolveView(folder.Get(), root, view, point, automation, fromPidl(root), L"explorer");
    CoTaskMemFree(root);
    if (!target.path.empty()) return target;
  }
  return {};
}

std::string utf8(const std::wstring& value) {
  if (value.empty()) return {};
  int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string result(size, '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), size, nullptr, nullptr);
  return result;
}
std::string json(const std::wstring& value) {
  std::string result = "\"";
  for (const unsigned char ch : utf8(value)) {
    if (ch == '"' || ch == '\\') { result += '\\'; result += ch; }
    else if (ch < 32) {
      char escaped[7]; sprintf_s(escaped, "\\u%04x", ch); result += escaped;
    } else result += ch;
  }
  return result + "\"";
}
void report(const Target& target, const char* status) {
  std::cout << "{\"status\":\"" << status << "\",\"directory\":" << json(target.path)
            << ",\"kind\":" << json(target.kind) << "}" << std::endl;
}

void roundedRect(Gdiplus::GraphicsPath& path, float x, float y, float width, float height, float radius) {
  const float diameter = radius * 2;
  path.AddArc(x, y, diameter, diameter, 180, 90);
  path.AddArc(x + width - diameter, y, diameter, diameter, 270, 90);
  path.AddArc(x + width - diameter, y + height - diameter, diameter, diameter, 0, 90);
  path.AddArc(x, y + height - diameter, diameter, diameter, 90, 90);
  path.CloseFigure();
}

// Show only the download label and destination path on a translucent card.
void renderFeedback(int x, int y, float scale) {
  using namespace Gdiplus;
  const float cardWidth = feedbackCardWidth;
  const float cardHeight = feedbackCardHeight;
  const int width = static_cast<int>((cardWidth + feedbackPadding) * scale);
  const int height = static_cast<int>((cardHeight + feedbackPadding) * scale);
  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = width; info.bmiHeader.biHeight = -height;
  info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32;
  info.bmiHeader.biCompression = BI_RGB;
  void* pixels = nullptr;
  HDC screen = GetDC(nullptr);
  HBITMAP dib = CreateDIBSection(screen, &info, DIB_RGB_COLORS, &pixels, nullptr, 0);
  HDC memory = CreateCompatibleDC(screen);
  if (dib && pixels && memory) {
    HGDIOBJ previous = SelectObject(memory, dib);
    {
      Bitmap bitmap(width, height, width * 4, PixelFormat32bppPARGB, static_cast<BYTE*>(pixels));
      Graphics graphics(&bitmap);
      graphics.Clear(Color(0, 0, 0, 0));
      graphics.ScaleTransform(scale, scale);
      graphics.SetSmoothingMode(SmoothingModeAntiAlias);
      graphics.SetTextRenderingHint(TextRenderingHintAntiAliasGridFit);
      GraphicsPath shadow, card;
      roundedRect(shadow, 5, 7, cardWidth + 2, cardHeight + 2, 14);
      SolidBrush shadowBrush(Color(65, 0, 0, 0));
      graphics.FillPath(&shadowBrush, &shadow);
      roundedRect(card, 6, 4, cardWidth, cardHeight, 12);
      graphics.SetCompositingMode(CompositingModeSourceCopy);
      SolidBrush destinationBrush(Color(190, 20, 26, 36));
      graphics.FillPath(&destinationBrush, &card);
      graphics.SetCompositingMode(CompositingModeSourceOver);
      Pen border(Color(65, 199, 215, 237), 1);
      graphics.DrawPath(&border, &card);
      FontFamily family(L"Segoe UI");
      Font detailFont(&family, 14, FontStyleRegular, UnitPixel);
      StringFormat format;
      format.SetFormatFlags(StringFormatFlagsNoWrap);
      format.SetLineAlignment(StringAlignmentCenter);
      SolidBrush labelBrush(Color(255, 145, 233, 200));
      RectF labelBounds;
      graphics.MeasureString(copyLabel.c_str(), -1, &detailFont, PointF(0, 0), &labelBounds);
      const float labelWidth = std::min(labelBounds.Width, 160.0f);
      graphics.DrawString(copyLabel.c_str(), -1, &detailFont, RectF(22, 4, labelWidth, cardHeight), &format, &labelBrush);
      format.SetTrimming(StringTrimmingEllipsisPath);
      SolidBrush pathBrush(Color(255, 247, 250, 255));
      graphics.DrawString(currentTarget.path.c_str(), -1, &detailFont,
        RectF(22 + labelWidth + 6, 4, 382 - labelWidth, cardHeight), &format, &pathBrush);
    }
    POINT location{x, y}, source{};
    SIZE size{width, height};
    BLENDFUNCTION blend{AC_SRC_OVER, 0, 255, AC_SRC_ALPHA};
    UpdateLayeredWindow(overlay, screen, &location, &size, memory, &source, 0, &blend, ULW_ALPHA);
    SelectObject(memory, previous);
  }
  if (memory) DeleteDC(memory);
  if (dib) DeleteObject(dib);
  ReleaseDC(nullptr, screen);
}

LRESULT CALLBACK paint(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  if (message == WM_NCHITTEST) return HTTRANSPARENT;
  return DefWindowProcW(window, message, wparam, lparam);
}

int wmain(int argc, wchar_t** argv) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return 1;
  if (argc == 3 && std::wstring(argv[1]) == L"--restore-cursor") {
    const HWND owner = reinterpret_cast<HWND>(_wcstoui64(argv[2], nullptr, 10));
    const DWORD thread = GetWindowThreadProcessId(owner, nullptr);
    MSG message{}; PeekMessageW(&message, nullptr, 0, 0, PM_NOREMOVE);
    if (thread && AttachThreadInput(GetCurrentThreadId(), thread, TRUE)) {
      int count = ShowCursor(TRUE);
      if (count > 0) ShowCursor(FALSE);
      while (count < 0) count = ShowCursor(TRUE);
      SetCursor(LoadCursorW(nullptr, IDC_ARROW));
      AttachThreadInput(GetCurrentThreadId(), thread, FALSE);
    }
    return 0;
  }
  ComPtr<IShellWindows> windows;
  ComPtr<IUIAutomation> automation;
  CoCreateInstance(CLSID_ShellWindows, nullptr, CLSCTX_LOCAL_SERVER, IID_PPV_ARGS(&windows));
  CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation));
  if (argc == 4 && std::wstring(argv[1]) == L"--probe") {
    probing = true;
    const auto target = resolve({static_cast<LONG>(_wtol(argv[2])), static_cast<LONG>(_wtol(argv[3]))}, windows.Get(), automation.Get());
    report(target, target.path.empty() ? "cancelled" : "dropped");
    return 0;
  }
  if (argc != 7 && argc != 9) return 1;
  const HWND owner = reinterpret_cast<HWND>(_wcstoui64(argv[1], nullptr, 10));
  HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, wcstoul(argv[2], nullptr, 10));
  // Keep accepting the existing bridge arguments; source names and target
  // display names are no longer rendered in the destination feedback.
  copyLabel = argv[3];
  const DWORD timeout = std::min<DWORD>(120000, wcstoul(argv[6], nullptr, 10));
  if (!parent || !IsWindow(owner) || !(GetAsyncKeyState(VK_LBUTTON) & 0x8000)) { report({}, "cancelled"); return 0; }
  Gdiplus::GdiplusStartupInput gdiplusInput;
  ULONG_PTR gdiplusToken = 0;
  if (Gdiplus::GdiplusStartup(&gdiplusToken, &gdiplusInput, nullptr) != Gdiplus::Ok) return 1;
  WNDCLASSW wc{}; wc.lpfnWndProc = paint; wc.hInstance = GetModuleHandleW(nullptr); wc.lpszClassName = L"NetcattySftpDropFeedback";
  RegisterClassW(&wc);
  overlay = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED | WS_EX_TRANSPARENT,
    wc.lpszClassName, L"Netcatty SFTP destination", WS_POPUP | WS_DISABLED, 0, 0,
    static_cast<int>(feedbackCardWidth + feedbackPadding), static_cast<int>(feedbackCardHeight + feedbackPadding),
    nullptr, nullptr, wc.hInstance, nullptr);
  const ULONGLONG started = GetTickCount64();
  DragCursorVisibility cursor(owner);
  bool dropped = false;
  GetAsyncKeyState(VK_ESCAPE);
  while (GetTickCount64() - started < timeout && IsWindow(owner) && WaitForSingleObject(parent, 0) == WAIT_TIMEOUT) {
    DWORD cancelBytes = 0;
    if (PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &cancelBytes, nullptr) && cancelBytes) break;
    MSG message{};
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
    if (GetAsyncKeyState(VK_ESCAPE) & 0x8001) break;
    POINT point{}; GetCursorPos(&point);
    // Let the original HTML drag own every in-app target. Only show external
    // feedback and ask Shell for a destination after leaving the source app.
    if (GetAncestor(WindowFromPoint(point), GA_ROOT) == owner) {
      cursor.restore();
      currentTarget = {};
      ShowWindow(overlay, SW_HIDE);
      if (!(GetAsyncKeyState(VK_LBUTTON) & 0x8000)) break;
      Sleep(35);
      continue;
    }
    currentTarget = resolve(point, windows.Get(), automation.Get());
    // Read the button again after COM/UI Automation calls, which may take time.
    // Resolve afresh at release so a previous hover target cannot be reused.
    if (!(GetAsyncKeyState(VK_LBUTTON) & 0x8000)) {
      GetCursorPos(&point);
      currentTarget = resolve(point, windows.Get(), automation.Get());
      dropped = !currentTarget.path.empty();
      break;
    }
    cursor.hide();
    if (currentTarget.path.empty()) {
      ShowWindow(overlay, SW_HIDE);
      Sleep(35);
      continue;
    }
    HMONITOR monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);
    MONITORINFO monitorInfo{sizeof(MONITORINFO)}; GetMonitorInfoW(monitor, &monitorInfo);
    SetWindowPos(overlay, HWND_TOPMOST, point.x + 22, point.y + 24, 0, 0, SWP_NOACTIVATE | SWP_NOSIZE);
    const float scale = static_cast<float>(GetDpiForWindow(overlay)) / 96;
    const int width = static_cast<int>((feedbackCardWidth + feedbackPadding) * scale);
    const int height = static_cast<int>((feedbackCardHeight + feedbackPadding) * scale);
    const int x = std::max(monitorInfo.rcWork.left, std::min(point.x + 22, monitorInfo.rcWork.right - width));
    const int y = std::max(monitorInfo.rcWork.top, std::min(point.y + 24, monitorInfo.rcWork.bottom - height));
    renderFeedback(x, y, scale);
    ShowWindow(overlay, SW_SHOWNOACTIVATE);
    Sleep(35);
  }
  cursor.restore(true);
  DestroyWindow(overlay); CloseHandle(parent);
  Gdiplus::GdiplusShutdown(gdiplusToken);
  report(currentTarget, dropped ? "dropped" : "cancelled");
  return 0;
}

"use strict";
if (!process.versions.electron) {
  require("node:test")("global wallpaper renders behind real terminal panes", {
    skip: "run npm run test:app-background with Electron",
  }, () => {});
} else {
  const assert = require("node:assert/strict");
  const { app, BrowserWindow, nativeImage } = require("electron");
  const fs = require("node:fs");
  const path = require("node:path");
  const esbuild = require("esbuild");
  const temp = require("../electron/bridges/tempDirBridge.cjs");
  const { createAppBackgroundService } = require("../electron/bridges/appBackground.cjs");
  const root = path.resolve(__dirname, "..");
  const userData = fs.mkdtempSync(`${temp.getTempFilePath("app-background-live")}-`);
  app.setPath("userData", userData);
  app.on("window-all-closed", () => {});
  let win;
  const finish = (code) => {
    win?.destroy();
    try { fs.rmSync(userData, { recursive: true, force: true }); }
    catch { /* Chromium can hold its cache open until app.exit on Windows. */ }
    app.exit(code);
  };
  const timeout = setTimeout(() => { console.error("Wallpaper smoke test timed out"); finish(1); }, 60_000);
  void app.whenReady().then(async () => {
    const bundle = esbuild.buildSync({
      stdin: { contents: [
        'export {createRoot} from "react-dom/client";',
        'export {createElement} from "react";',
        'export {AppBackgroundLayer} from "./components/AppBackgroundLayer";',
        'export {alignTerminalPaneRect} from "./domain/terminalPaneGeometry";',
        'export {TerminalPaddingBackground} from "./components/terminal/TerminalPaddingBackground";',
        'export {publishAppBackground} from "./application/state/appBackgroundStore";',
        'export {createXTermRuntime} from "./components/terminal/runtime/createXTermRuntime";',
        'export {DEFAULT_TERMINAL_SETTINGS} from "./domain/models/terminal";',
        'export {applyTerminalThemeSync} from "./components/terminal/terminalThemeScheduler";',
        'export {buildNetcattyMonacoThemeColors} from "./infrastructure/monaco/netcattyMonacoTheme";',
      ].join("\n"), loader: "ts", resolveDir: root },
      bundle: true, format: "cjs", platform: "browser", target: "chrome148", write: false,
      alias: { "node:diagnostics_channel": path.join(root, "infrastructure/shims/nodeDiagnosticsChannel.ts"),
        "diagnostics_channel": path.join(root, "infrastructure/shims/nodeDiagnosticsChannel.ts") },
      define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta": "{}" },
    }).outputFiles[0].text;
    win = new BrowserWindow({ show: false, width: 960, height: 640, useContentSize: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false, offscreen: true } });
    await win.loadURL("data:text/html,<body style='margin:0;background:%23000'><div id='root'></div>");
    const css = fs.readFileSync(path.join(root, "index.css"), "utf8");
    await win.webContents.insertCSS(css.slice(css.indexOf("/* Wallpaper"), css.indexOf("/* Bundled icon-only")));
    await win.webContents.insertCSS(fs.readFileSync(require.resolve("@xterm/xterm/css/xterm.css"), "utf8"));
    await win.webContents.executeJavaScript(`(async () => {
      const loaded = {exports:{}};
      ((module,exports)=>{${bundle}})(loaded,loaded.exports);
      const api = loaded.exports;
      window.wallpaperTest = api;
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const root = document.getElementById('root');
      root.style.cssText = 'position:relative;isolation:isolate;width:960px;height:640px;--background:0 0% 0%;--secondary:0 0% 0%;--terminal-ui-bg:#000000;color:white';
      const picture = document.createElement('canvas'); picture.width=2;picture.height=2;
      const painter=picture.getContext('2d');painter.fillStyle='#f04060';painter.fillRect(0,0,2,2);
      api.snapshot = {settings:{enabled:true,imageId:null,surfaceOpacity:0.5},imageUrl:picture.toDataURL(),effectiveEnabled:true,busy:false,error:false};
      api.publishAppBackground(api.snapshot);
      api.reactRoot = api.createRoot(root);
      api.reactRoot.render(api.createElement(api.AppBackgroundLayer));
      await wait(50);
      const tabs=document.createElement('div');tabs.dataset.appBackgroundSurface='tabs';tabs.style.cssText='height:40px';tabs.textContent='Netcatty wallpaper preview';root.append(tabs);
      const sidebar=document.createElement('div');sidebar.dataset.appBackgroundSurface='base';sidebar.style.cssText='position:absolute;top:40px;left:0;bottom:0;width:220px';sidebar.textContent='Hosts / settings / editor';root.append(sidebar);
      const nested=document.createElement('div');nested.dataset.appBackgroundSurface='transparent';nested.style.cssText='height:100px;background:#000';sidebar.append(nested);
      const ref = current => ({current});
      api.theme={id:'test',type:'dark',colors:{background:'#000000',foreground:'#eeeeee',cursor:'#ffffff',selection:'#444444',blue:'#1122cc'}};
      api.runtimes=[];
      for(let index=0;index<2;index++) {
        const shell=document.createElement('div');shell.dataset.section='terminal-split-pane';shell.style.cssText='position:absolute;top:40px;bottom:0;left:'+(220+370*index)+'px;width:370px;background:#000';root.append(shell);
        api.createRoot(shell).render(api.createElement(api.TerminalPaddingBackground,{top:30}));
        await wait(50);
        const toolbar=document.createElement('div');toolbar.dataset.appBackgroundSurface='base';toolbar.style.cssText='position:absolute;top:0;left:0;right:0;height:30px;background:#000';shell.append(toolbar);
        const container=document.createElement('div');container.className='xterm-container';container.dataset.appBackgroundSurface='transparent';container.style.cssText='position:absolute;inset:40px 10px 10px;background:#000';shell.append(container);
        const runtime=api.createXTermRuntime({container,host:{id:'test-'+index,label:'test',hostname:'localhost',protocol:'ssh'},
          fontFamilyId:'jetbrains-mono',resolvedFontFamily:'monospace',fontSize:14,terminalTheme:api.theme,
          terminalSettingsRef:ref({...api.DEFAULT_TERMINAL_SETTINGS,cursorBlink:false,rendererType:'webgl'}),terminalBackend:{write:()=>{},resize:()=>{},openExternalAvailable:false},
          sessionRef:ref('test-'+index),hotkeySchemeRef:ref('disabled'),disableTerminalFontZoomRef:ref(false),keyBindingsRef:ref([]),onHotkeyActionRef:ref(undefined),
          isBroadcastEnabledRef:ref(false),onBroadcastInputRef:ref(undefined),sessionId:'test-'+index,statusRef:ref('connected'),commandBufferRef:ref(''),requestSearchFocus:()=>{}});
        runtime.fitAddon.fit();api.runtimes.push(runtime);
        await new Promise(resolve=>runtime.term.write('Wallpaper terminal '+index+'\\r\\n\\x1b[44m                    \\x1b[0m\\r\\n',resolve));
      }
      api.setOpacity=async (opacity,enabled=true)=>{
        root.style.setProperty('--terminal-ui-bg',api.theme.colors.background);
        api.snapshot={...api.snapshot,effectiveEnabled:enabled,settings:{...api.snapshot.settings,surfaceOpacity:opacity}};
        api.publishAppBackground(api.snapshot);
        api.runtimes.forEach(runtime=>api.applyTerminalThemeSync(runtime.term,api.theme));
        if(!enabled) root.querySelectorAll('[data-app-background-surface="base"]').forEach(el=>el.style.background='#000');
        await wait(150);
      };
      await api.setOpacity(0.5);
      const assert=require('node:assert/strict');
      assert.equal(root.dataset.appBackground,'enabled');
      assert.equal(getComputedStyle(nested).backgroundColor,'rgba(0, 0, 0, 0)');
      assert.ok(root.querySelector('canvas'),'real terminal renderer is mounted');
      assert.equal(window.__xtermWebGLLoaded,true,'WebGL renderer must be active for the first pixel comparison');
      for(const runtime of api.runtimes) assert.equal(runtime.term.options.theme.background,'#00000080');
      api.ansiSample=()=>{
        const runtime=api.runtimes[0];
        const bounds=runtime.term.element.querySelector('.xterm-screen').getBoundingClientRect();
        return [Math.floor(bounds.x+bounds.width/runtime.term.cols*4.5),Math.floor(bounds.y+bounds.height/runtime.term.rows*1.5)];
      };
      const settings=document.createElement('div');settings.className='settings-window';
      settings.dataset.appBackgroundSurface='transparent';
      settings.style.cssText='position:absolute;isolation:isolate;left:0;top:600px;width:200px;height:40px';root.append(settings);
      api.settingsRoot=api.createRoot(settings);api.settingsRoot.render(api.createElement(api.AppBackgroundLayer));
      await wait(100);
    })()`);
    function pixel(image, x, y) {
      const width = image.getSize().width;
      const bitmap = image.toBitmap();
      const offset = (y * width + x) * 4;
      return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]];
    }
    function near(actual, expected) { actual.forEach((channel, index) => assert.ok(Math.abs(channel - expected[index]) <= 4, `${actual} != ${expected}`)); }
    let screenshot = await win.webContents.capturePage();
    near(pixel(screenshot, 100, 400), [120, 32, 48]);
    near(pixel(screenshot, 300, 400), [120, 32, 48]);
    near(pixel(screenshot, 700, 400), [120, 32, 48]);
    // Insets, whole-cell remainder and scrollbar gutter have exactly one tint.
    for (const [x, y] of [[225,400],[585,400],[300,75],[300,635]]) near(pixel(screenshot,x,y),[120,32,48]);
    // The settings window has its own background image and one mask, not two.
    near(pixel(screenshot, 100, 620), [120, 32, 48]);
    const ansiSample = await win.webContents.executeJavaScript('wallpaperTest.ansiSample()');
    const ansiColor = pixel(screenshot, ...ansiSample);
    near(ansiColor, [17, 34, 204]);
    // Opening a sidebar shrinks the clip host before xterm's debounced fit.
    // Keep the old screen width for several paints: the margin between the
    // clipping host and pane edge must still have exactly one theme tint.
    for (const renderer of ['webgl', 'dom']) {
      await win.webContents.executeJavaScript(`(async()=>{
        const runtime=wallpaperTest.runtimes[0];
        runtime.${renderer === 'dom' ? 'suspendWebglRenderer' : 'ensureWebglRenderer'}();
        const container=runtime.term.element.parentElement;
        const shell=container.parentElement;
        // Production clips the xterm viewport, not the outer margin host.
        runtime.term.element.style.overflowX='clip';
        wallpaperTest.resizeFixture={container,shell,screen:runtime.term.element.querySelector('.xterm-screen'),oldWidth:shell.style.width};
        shell.style.width='250px';
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const fixture=wallpaperTest.resizeFixture;
        require('node:assert/strict').ok(fixture.screen.getBoundingClientRect().right>container.getBoundingClientRect().right,'xterm must still have its pre-fit width');
      })()`);
      for (let frame=0;frame<3;frame++) {
        screenshot=await win.webContents.capturePage();
        near(pixel(screenshot,300,400),[120,32,48]);
        // Full 10px right margin, including the strip the old hole exposed.
        for(let x=460;x<470;x++) for(let y=100;y<590;y+=7) near(pixel(screenshot,x,y),[120,32,48]);
      }
      await win.webContents.executeJavaScript(`(async()=>{
        const {shell,oldWidth}=wallpaperTest.resizeFixture;
        shell.style.width=oldWidth;
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      })()`);
    }
    // Odd widths and unequal splits place the right pane at a fractional CSS
    // origin. Exercise the real pane geometry adapter, with both renderers,
    // and inspect every margin/canvas boundary pixel (not just pane centers).
    for (const renderer of ['webgl', 'dom']) {
      for (const edge of [490.5, 511.375, 537.625]) {
        await win.webContents.executeJavaScript(`(async()=>{
          const api=wallpaperTest;
          api.fractionalOriginals=api.runtimes.map(runtime=>{
            const shell=runtime.term.element.parentElement.parentElement;
            return {shell,left:shell.style.left,width:shell.style.width};
          });
          const rects=[{x:220,y:0,w:${edge}-220,h:600},{x:${edge},y:0,w:960-${edge},h:600}].map(api.alignTerminalPaneRect);
          api.runtimes.forEach((runtime,index)=>{
            runtime.${renderer === 'dom' ? 'suspendWebglRenderer' : 'ensureWebglRenderer'}();
            const shell=api.fractionalOriginals[index].shell;
            shell.style.left=rects[index].x+'px';shell.style.width=rects[index].w+'px';
            runtime.fitAddon.fit();
          });
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        })()`);
        screenshot=await win.webContents.capturePage();
        const border=Math.round(edge);
        for(let x=border-2;x<border+45;x++) for(let y=180;y<580;y+=31) {
          try { near(pixel(screenshot,x,y),[120,32,48]); }
          catch (error) { throw new Error(`${renderer} split ${edge} at ${x},${y}: ${error.message}`); }
        }
        await win.webContents.executeJavaScript(`(async()=>{
          wallpaperTest.fractionalOriginals.forEach(({shell,left,width},index)=>{
            shell.style.left=left;shell.style.width=width;wallpaperTest.runtimes[index].fitAddon.fit();
          });
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        })()`);
      }
    }
    await win.webContents.executeJavaScript(`wallpaperTest.runtimes[0].ensureWebglRenderer()`);
    // Check the mask in the resize delivery itself, before another animation
    // frame can hide a one-frame hole/overlap during a side-panel toggle.
    await win.webContents.executeJavaScript(`(async()=>{
      const runtime=wallpaperTest.runtimes[0];
      const screen=runtime.term.element.querySelector('.xterm-screen');
      const container=runtime.term.element.parentElement;
      const layer=container.parentElement.querySelector('.terminal-padding-background');
      for(const right of ['130px','10px','90px','10px']) {
        await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{observer.disconnect();reject(new Error('Resize mask timed out'));},2000);
          const observer=new ResizeObserver(()=>{
            observer.disconnect();clearTimeout(timer);
            const outer=layer.getBoundingClientRect(),inner=screen.getBoundingClientRect();
            const edge=(inner.right-outer.left)+'px '+(inner.top-outer.top)+'px';
            if(!layer.style.clipPath.includes(edge)) reject(new Error('Stale mask before paint: '+layer.style.clipPath+' expected '+edge));
            else resolve();
          });
          observer.observe(screen);
          container.style.right=right;runtime.fitAddon.fit();
        });
      }
      const fixture=document.createElement('div');fixture.id='vault-frame-fixture';
      fixture.style.cssText='position:absolute;z-index:100;left:20px;top:540px;width:180px;height:40px;background-image:url("'+wallpaperTest.snapshot.imageUrl+'")';
      const stage=document.createElement('div');stage.dataset.section='vault-stage';stage.style.cssText='position:relative;width:100%;height:100%;box-sizing:border-box;padding:0 8px 8px 0';fixture.append(stage);
      const content=document.createElement('div');content.dataset.appBackgroundSurface='base';content.style.cssText='width:100%;height:100%';stage.append(content);
      document.getElementById('root').append(fixture);
    })()`);
    screenshot = await win.webContents.capturePage();
    // Vault bottom/right padding and interior each have one theme tint.
    for (const [x,y] of [[50,575],[196,550],[196,575],[50,550]]) near(pixel(screenshot,x,y),[120,32,48]);
    await win.webContents.executeJavaScript(`document.getElementById('vault-frame-fixture').remove()`);
    await win.webContents.executeJavaScript(`wallpaperTest.setOpacity(0.25)`);
    screenshot = await win.webContents.capturePage();
    near(pixel(screenshot, 300, 400), [180, 48, 72]);
    for (const [x, y] of [[225,400],[585,400],[300,75],[300,635]]) near(pixel(screenshot,x,y),[180,48,72]);
    // Repeated frames must neither accumulate opacity nor leave old glyphs.
    await win.webContents.executeJavaScript(`(async()=>{for(let i=0;i<5;i++) {wallpaperTest.runtimes.forEach(r=>r.term.refresh(0,r.term.rows-1));await new Promise(resolve=>setTimeout(resolve,30));}})()`);
    screenshot = await win.webContents.capturePage();
    near(pixel(screenshot, 300, 400), [180, 48, 72]);
    await win.webContents.executeJavaScript(`document.getElementById('root').style.setProperty('--background','0 0% 100%');wallpaperTest.theme={...wallpaperTest.theme,colors:{...wallpaperTest.theme.colors,background:'#ffffff'}};wallpaperTest.setOpacity(0.5)`);
    screenshot = await win.webContents.capturePage();
    near(pixel(screenshot, 100, 400), [247, 160, 176]);
    near(pixel(screenshot, 300, 400), [247, 160, 176]);
    for (const [x, y] of [[225,400],[585,400],[300,75],[300,635],[300,55]]) near(pixel(screenshot,x,y),[247,160,176]);
    await win.webContents.executeJavaScript(`document.getElementById('root').style.setProperty('--background','0 0% 0%');wallpaperTest.theme={...wallpaperTest.theme,colors:{...wallpaperTest.theme.colors,background:'#000000'}};wallpaperTest.setOpacity(0.25)`);
    // Both renderers must reveal the same wallpaper without attenuating ANSI cells.
    await win.webContents.executeJavaScript(`wallpaperTest.runtimes.forEach(r=>r.suspendWebglRenderer()); wallpaperTest.setOpacity(0.25)`);
    screenshot = await win.webContents.capturePage();
    near(pixel(screenshot, 100, 400), [180, 48, 72]);
    near(pixel(screenshot, 300, 400), [180, 48, 72]);
    await win.webContents.executeJavaScript(`wallpaperTest.runtimes.forEach(r=>r.ensureWebglRenderer());wallpaperTest.setOpacity(0.25)`);
    screenshot = await win.webContents.capturePage();
    near(pixel(screenshot, 300, 400), [180, 48, 72]);
    await win.webContents.executeJavaScript(`wallpaperTest.setOpacity(0.25,false)`);
    screenshot = await win.webContents.capturePage();
    near(pixel(screenshot, 300, 400), [0, 0, 0]);
    const source = path.join(userData, "source.png");
    fs.writeFileSync(source, nativeImage.createFromBuffer(screenshot.toPNG()).toPNG());
    const service = createAppBackgroundService({ directory: path.join(userData, "backgrounds"), nativeImage, selectFile: async () => source });
    const imported = await service.importImage();
    fs.unlinkSync(source);
    assert.match(await service.load(imported.imageId), /^data:image\/png;base64,/);
    await service.remove(imported.imageId);
    assert.equal(await service.load(imported.imageId), null);
    const jpegSource = path.join(userData, 'source.jpg');
    fs.writeFileSync(jpegSource, screenshot.toJPEG(85));
    const jpegService = createAppBackgroundService({ directory: path.join(userData, 'backgrounds'), nativeImage, selectFile: async () => jpegSource });
    const jpeg = await jpegService.importImage();
    assert.match(await jpegService.load(jpeg.imageId), /^data:image\/jpeg;base64,/);
    await jpegService.remove(jpeg.imageId);
    console.log("APP_BACKGROUND_RENDERING_OK", JSON.stringify({ split: true, renderers: ['webgl', 'dom'], themes: ['dark', 'light'], nativeDecoder: ['png', 'jpeg'], sourceMoved: true, opacity: [0.5, 0.25], ansiBackground: true, sidebarExpansionBeforeFit: true, fractionalSplitEdges: true, disabled: true }));
    clearTimeout(timeout);
    finish(0);
  }).catch((error) => { console.error(error); clearTimeout(timeout); finish(1); });
}

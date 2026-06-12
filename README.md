# 手势控制发光粒子球（移动端可部署）

这是一个基于 **Vite + React + TypeScript** 的纯前端网页：
- 使用 `@mediapipe/tasks-vision` 的 `HandLandmarker` 进行手部识别
- 使用 `Three.js` 渲染发光粒子球
- 手机可用手势控制（前置摄像头）
- 无摄像头时提供触摸/鼠标回退交互

## 快速开始

```bash
npm install
npm run dev
npm run build
npm run preview
```

## 本机开发

```bash
# 开发模式（暴露到局域网，方便手机访问开发服务器）
npm run dev -- --host 0.0.0.0
```

注意：
- 浏览器的 `getUserMedia` 通常要求 **HTTPS** 或 `localhost`。
- 局域网 `http://IP:5173` 在手机上很可能能看到页面，但摄像头权限通常会被阻止。
- 推荐测试时先用手机浏览器打开 `localhost` 替代方案（若在同一设备）或使用 HTTPS 隧道。

### 手机 HTTPS 访问（推荐）

本机的 `https://` 常见报错“无法建立安全链接”通常是证书不受信任导致。  
本项目更推荐使用这两种方案，避免手机浏览器拦截摄像头：

1) HTTPS 隧道（最快）

```bash
# 一条命令起服务
npm run dev -- --host 0.0.0.0 --port 5173

# 另开终端，用隧道提供受信任 HTTPS 域名
npm i -g ngrok
ngrok http 5173
```

打开 ngrok 给出的 `https://xxxx.ngrok-free.app` 即可。

2) 本机自签证书（mkcert）

```bash
winget install FiloSottile.Mkcert
mkcert -install
cd /path/to/gesture-particle-web
mkdir -p certs
mkcert -key-file certs/localhost-key.pem -cert-file certs/localhost.pem localhost 127.0.0.1 192.168.31.173
```

然后在 `vite.config.ts` 配置本地证书并启动 `npm run dev -- --host 0.0.0.0 --port 5173`，再用 `https://192.168.31.173:5173`。

```bash
npm run dev -- --host 0.0.0.0 --port 5173 --https certs/localhost.pem certs/localhost-key.pem
```

> 注意：第二种方式对局域网证书信任要求更严格，部分安卓/iOS 仍会提示证书问题。最稳妥是用 HTTPS 隧道。 

## 部署（HTTPS）

该项目无后端，`npm run build` 生成的 `dist` 可直接部署到任意 HTTPS 静态托管：
- Vercel / Netlify
- Cloudflare Pages
- GitHub Pages + HTTPS
- Nginx / Caddy / CDN

推荐：
1. `npm run build`
2. 将 `dist` 上传到静态站点
3. 使用 HTTPS 域名打开页面
4. 在手机浏览器点击“启动摄像头”

## 页面功能说明

- 点击 **启动摄像头**，默认请求前置摄像头：
  ```js
  {
    facingMode: "user",
    width: { ideal: 1280 },
    height: { ideal: 720 }
  }
  ```
- 后台仅在本地推理，不上传视频帧。
- 摄像头窗口支持右下角小窗展示，可点按钮隐藏。
- 切换按钮：前/后摄像头。
- 质量模式：
  - 省电：3000 粒子
  - 标准：6000 粒子
  - 高画质：10000 粒子
- 显示状态：loading model / camera ready / hand detected / no hand / pinch / open palm。
- 可开关 FPS 显示。
- 支持横竖屏自适应，窗口变化时重算渲染器。

## 触摸/鼠标兜底（无摄像头）

当：
- 当前环境不支持摄像头（如桌面无摄像头）
- 或用户拒绝权限

系统自动切到“触摸模式”：
- 单指拖动：模拟手掌整体移动
- 长按或双指靠近：模拟捏合
- 松开：模拟放开并触发一次粒子爆发

## 常见问题

- 手机打不开摄像头  
  检查 HTTPS、权限、是否已点击“启动摄像头”。
- iPhone 黑屏  
  确保 `video` 已设置 `playsInline`、`muted`、`autoplay`。
- 粒子卡顿  
  切到“省电”模式或调低分辨率环境下测试。
- 手势不准  
  保持手掌在画面中部，环境光充足，并尽量横向正对镜头。
- 提示“当前页面不是 HTTPS/localhost...”  
  说明当前环境不允许摄像头访问，项目会自动进入触摸模式，不影响粒子交互体验。

## 文件职责

- `src/handTracker.ts`  
  加载并管理 MediaPipe `HandLandmarker`，每隔 1~2 帧推理，产出关键点与手势状态。
- `src/gestures.ts`  
  由关键点计算手势状态（`normalizedPinch`、`pinchStrength`、`openPalmStrength`、pinchStart/Hold/Release）。
- `src/particleScene.ts`  
  Three.js 粒子系统与交互动画（弹簧阻尼、捏合聚拢、张手扩散、爆发）。
- `src/utils.ts`  
  工具函数、设备能力检测、颜色/纹理辅助。
- `src/App.tsx`  
  页面控制与事件编排（启动/切换摄像头、状态显示、质量切换、FPS、触摸兜底）。

## 目录结构

```text
src/
  App.tsx
  main.tsx
  styles.css
  handTracker.ts
  gestures.ts
  particleScene.ts
  utils.ts
```

# 视频去字幕工具 MVP

一个可部署到 Railway 的在线视频去字幕工具 MVP。V5 将流程改成更接近一键工具：上传视频后自动分析字幕区域、自动框出推荐范围，用户可微调后预览效果，再开始完整去字幕处理。后端生成文字级字幕 mask，并按 `fast / balanced / high_quality` 三档选择 OpenCV、Temporal OpenCV、ProPainter、LaMa 或外部 GPU API fallback 修复，最后用 FFmpeg 合成 mp4 并保留原视频音频。

## 当前部署形态

项目默认是单服务部署：

- Docker 构建 Next.js 前端静态文件。
- FastAPI 同时提供前端页面和 `/api/*` 接口。
- Railway 只需要部署一个服务。
- 用户只需要打开 Railway 生成的一个公网 URL。

## 项目结构

```text
frontend/
  app/
  components/

backend/
  main.py
  video_processor.py
  subtitle_region_detector.py
  mask_detector.py
  inpaint_engines.py
  storage.py
  jobs.py
  requirements.txt

Dockerfile
railway.json
.env.example
```

## 环境变量

参考 [.env.example](.env.example)：

```bash
PORT=8000
NEXT_PUBLIC_API_BASE_URL=
CORS_ALLOW_ORIGINS=
ENABLE_PROPAINTER=false
PROPAINTER_PATH=/app/models/propainter
PROPAINTER_DEVICE=cpu
ENABLE_LAMA=false
LAMA_MODEL_PATH=/app/models/lama
LAMA_DEVICE=cpu
ENABLE_GPU_API=false
GPU_API_URL=
GPU_API_KEY=
```

单容器部署时 `NEXT_PUBLIC_API_BASE_URL` 留空，前端会请求同域名下的 `/api`。如果以后拆成前后端两个服务，再把它设成后端公网地址。

## V5 一键流程

默认用户流程：

1. 上传视频。
2. 前端自动调用 `POST /api/auto-detect-subtitle-region`。
3. 页面显示推荐字幕区域和置信度。
4. 用户选择「智能全消」或「手动框选」。
5. 用户只需要选择「轻度 / 标准 / 强力」和「速度优先 / 平衡 / 效果优先」。
6. 点击「预览效果」，系统先生成 mask，再生成当前帧 before/after。
7. 点击「开始去字幕」。
8. 完成后下载 mp4。

简化强度会映射到内部参数：

```text
轻度：detection_sensitivity=0.68, mask_dilate=3, temporal_window=2, feather_radius=8
标准：detection_sensitivity=0.76, mask_dilate=4, temporal_window=3, feather_radius=10
强力：detection_sensitivity=0.84, mask_dilate=6, temporal_window=3, feather_radius=14
```

处理偏好映射：

```text
速度优先 = fast
平衡 = balanced
效果优先 = high_quality
```

高级参数仍保留在「高级设置」折叠区里，普通用户默认不需要打开。

## 修复模式和引擎 fallback

- `fast`：OpenCV inpaint，速度优先，适合快速预览。
- `balanced`：默认模式，文字级 mask + 前后帧 Temporal OpenCV 融合 + OpenCV 边缘收口。
- `high_quality`：优先外部 GPU API；没有 GPU API 时尝试 ProPainter；没有 ProPainter 时尝试 LaMa；都不可用时自动 fallback 到 Temporal OpenCV。

Railway 默认是 CPU 模式，Dockerfile 不会强制下载任何大模型。CPU 模式下 `high_quality` 会 fallback 到 `Temporal OpenCV`，页面会明确提示：当前服务器未启用 GPU 高质量引擎，正在使用 Temporal OpenCV。

要达到更接近商业级的干净效果，需要启用以下任一能力：

- ProPainter 视频修复模型。
- LaMa 单帧修复模型。
- 外部 GPU API。

如果要启用 ProPainter，需要自行把模型目录挂载或打包到镜像外部存储，并设置：

```bash
ENABLE_PROPAINTER=true
PROPAINTER_PATH=/app/models/propainter
PROPAINTER_DEVICE=cuda
```

或：

```bash
ENABLE_LAMA=true
LAMA_MODEL_PATH=/app/models/lama
LAMA_DEVICE=cpu
```

如果要启用外部 GPU API：

```bash
ENABLE_GPU_API=true
GPU_API_URL=https://your-gpu-service.example.com
GPU_API_KEY=your-secret-key
```

当前仓库只提供 GPU API 的可插拔适配结构，不绑定任何第三方服务。启用后 `high_quality` 会优先尝试 GPU API；如果适配器不可用或调用失败，会继续 fallback 到 ProPainter、LaMa 或 Temporal OpenCV。

页面会显示当前实际使用的修复引擎：`GPU API`、`ProPainter`、`LaMa`、`Temporal OpenCV` 或 `OpenCV`，不会在未启用模型时假装使用 ProPainter。

## 主要接口

- `POST /api/auto-detect-subtitle-region`：采样多帧，返回推荐字幕框、置信度、采样帧和提示。
- `POST /api/preview-mask`：返回当前帧 mask overlay 图、mask 覆盖率、组件数量和 warning。
- `POST /api/preview-repair-frame`：只修复当前时间点的一帧，返回 before / after 图片和实际预览引擎。
- `GET /api/engine-status`：返回当前服务器引擎能力和实际 fallback。
- `POST /api/process`：提交完整视频处理任务。
- `GET /api/status/{job_id}`：轻量查询任务状态。
- `GET /api/download/{job_id}`：下载处理后的 mp4。

前端「预览效果」会先调用 mask 预览，再调用当前帧修复预览。mask 覆盖率超过 25% 时会提示可能导致画面模糊；低于 1% 时会提示提高强度或重新框选。

## 本地 Docker 运行

先确保本机已安装 Docker。

```bash
docker build -t subtitle-remover-mvp .
docker run --rm -p 8000:8000 -e PORT=8000 subtitle-remover-mvp
```

打开：

```text
http://localhost:8000
```

本地 Docker 会在容器里安装：

- Node.js 20
- Python 3.11
- FFmpeg
- OpenCV 运行依赖
- 前端依赖并执行 `npm run build`
- 后端 Python 依赖

## Railway 部署步骤

1. 把项目推送到 GitHub 仓库。
2. 打开 Railway，点击 **New Project**。
3. 点击 **Deploy from GitHub repo**。
4. 选择这个仓库。
5. Railway 会识别根目录 `Dockerfile` 和 `railway.json`。
6. 在服务的 **Variables** 里确认：
   - `PORT` 不需要手动配置，Railway 会自动注入。
   - `NEXT_PUBLIC_API_BASE_URL` 单服务部署时可以不填或留空。
7. 点击 **Deploy**，等待构建完成。
8. 打开服务的 **Settings** 或 **Deployments**，点击 **Generate Domain** 生成公网域名。

部署成功后，你应该打开 Railway 生成的公网域名，例如：

```text
https://your-service-name.up.railway.app
```

这一个网址就是用户需要访问的前端网址，接口也在同一个域名下。

## 部署成功后怎么测试上传视频

1. 打开 Railway 生成的公网 URL。
2. 点击 **上传视频**，选择一个较短的 `mp4`、`mov` 或 `webm`。
3. 点击 **确认上传**。
4. 视频预览出现后，等待自动字幕区域识别完成。
5. 如果推荐框不准，拖拽框选区域微调，或切换到 **手动框选**。
6. 点击 **预览效果**，查看 mask 和当前帧 before/after。
7. 保持 **标准 + 平衡**，点击 **开始去字幕**。
8. 等待处理进度到 100%。
9. 点击 **下载结果**，下载处理后的 mp4。

建议先用 5 到 15 秒的小视频测试，确认 Railway 机器规格和处理速度符合预期。

## 如果拆成两个 Railway 服务

当前项目不需要拆服务。如果以后必须拆成 frontend/backend 两个服务，可以这样做：

### Backend 服务

- 使用 `backend/` 作为服务目录，安装 Python 依赖。
- 安装系统依赖：`ffmpeg`、`libgl1`、`libglib2.0-0`、`libgomp1`、`libsm6`、`libxext6`、`libxrender1`。
- 启动命令：

```bash
uvicorn main:app --host 0.0.0.0 --port ${PORT}
```

- 生成后端公网域名，例如：

```text
https://subtitle-backend.up.railway.app
```

- 如果 frontend 使用自定义域名，在 backend 服务里设置：

```bash
CORS_ALLOW_ORIGINS=https://your-frontend-domain.com
```

### Frontend 服务

- 使用 `frontend/` 作为服务目录。
- 设置环境变量：

```bash
NEXT_PUBLIC_API_BASE_URL=https://subtitle-backend.up.railway.app
```

- 重新构建前端，因为 `NEXT_PUBLIC_*` 会在 build 时写入浏览器代码。

拆服务后用户打开 frontend 服务的公网 URL，`NEXT_PUBLIC_API_BASE_URL` 填 backend 服务的公网 URL。

## MVP 注意事项

- 上传大小限制为 500MB。
- 仅允许 `mp4`、`mov`、`webm`。
- 任务进度保存在内存中，重启后会丢失。
- 本地文件存储在容器文件系统内，Railway 重新部署后历史上传和输出文件不会保留。
- V5 默认重点是一键流程、自动字幕区域识别、文字级 mask + Temporal OpenCV；ProPainter/LaMa/GPU API 为可选高质量能力，不做复杂账号、付费或队列系统。
- Railway CPU 环境可以稳定使用，但很难达到商业级模型效果。想要更干净的背景纹理和运动修复，建议接 ProPainter 或外部 GPU API。
- 请只处理自己拥有版权或获得授权的视频。

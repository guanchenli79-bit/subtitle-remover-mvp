# 视频去字幕工具 MVP

一个可部署到 Railway 的在线视频去字幕工具 MVP。用户上传视频后，在 HTML5 video 预览画面上框选字幕区域，后端使用 OpenCV 只对框选区域内检测到的文字像素生成 mask，并用 `cv2.inpaint` 修复，最后用 FFmpeg 合成 mp4 并保留原视频音频。

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
```

单容器部署时 `NEXT_PUBLIC_API_BASE_URL` 留空，前端会请求同域名下的 `/api`。如果以后拆成前后端两个服务，再把它设成后端公网地址。

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
4. 视频预览出现后，在字幕位置拖拽出矩形框。
5. 确认右侧显示 `X / Y / 宽 / 高` 坐标。
6. 保持默认参数，点击 **开始去字幕处理**。
7. 等待处理进度到 100%。
8. 点击 **下载视频**，下载处理后的 mp4。

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
- 第一版重点是文字像素 mask + OpenCV inpaint，不做复杂 OCR 和队列系统。
- 请只处理自己拥有版权或获得授权的视频。

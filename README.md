# 课伴 · Tingke Pocket

轻量手机听课页与 ChatGPT 插件。原生 HTML/CSS/JavaScript、零运行时依赖，不要求额外模型 API 密钥。

## 如何用

1. 安装并连接发布后的课伴插件。在 ChatGPT 中说：**“用课伴开始听课。”**
2. 打开听课页，填写课程名称，点击开始。首次使用按手机提示授权麦克风。
3. 想拍 PPT 或板书时展开页内相机。相机只请求视频，不重新申请麦克风；快门保存当前录音经过时间。拍完收起相机。
4. 结束后回到 ChatGPT，说：**“用课伴读取刚才的课，逐张整理照片；老师讲解只使用已有讲稿，AI 补充单独标明，并保存笔记。”**
5. 若当前 ChatGPT 宿主限制麦克风、相机或文件，使用页面提供的浏览器入口；在同一账号下取回相同资料。

发布后的私有听课页：

<https://tingke-pocket-20261115.flatturnip.chatgpt.site>

该地址只允许有 Site 访问权的账号使用。部署成功与手机真机兼容性是不同的验证步骤。

## 已实现的范围

- 单一 MediaRecorder 连续录音，优先 Safari `audio/mp4`，48 kbps 目标码率，约 10 秒分片；保留容器头及全部原始字节。
- 暂停、继续、结束；录音时钟排除暂停时间；结束等待尾片本地写入。
- 页内后置相机取景；照片带录音时间；不停止录音器来拍照。
- IndexedDB 按账号隔离，本地素材与上传队列原子保存，确认云端写入后才清除上传任务。刷新后显示已有资料与中断状态，不能继续捕获刷新期间的声音。
- Site R2 私有持久存储；用户身份由 Sites 提供，后端按用户隔离课程、图片、音频和笔记。
- 可选设备／浏览器听写（是否存在、语言与稳定性依设备决定），也可导入／粘贴讲稿。听写失败不会制造转写内容。
- 当前 ChatGPT 通过 MCP 读取真实照片与已有讲稿并生成中文笔记，保存时保留修订历史。
- 按容器组拼接录音回放与导出；Markdown 笔记导出。

## 明确的能力边界

**课伴没有调用 ChatGPT 内置 Voice、Record、官方语音输入或任何私有 `chatgpt.com/backend-api` 接口。**

当前公开插件桥接没有本项目已验证的“调用官方持续语音转写”入口。ChatGPT 的订阅也不是本项目可自行读取的 API 凭据。这里不要求用户贴密钥，不读取登录凭据，不自动收费调用独立模型 API。

当前 ChatGPT 可以看插件返回的课堂照片和文本讲稿。**只保存了原始录音、没有讲稿时，不能宣称已知道老师说了什么。** 插件会明确标出缺少转写，由当前 GPT 整理可见图片及已存在的文字。音频文件传输成功不等于长音频可由 ChatGPT 自动转写。

五小时是目标使用时长，**尚未在 iPhone 17 Pro 上做五小时连续收音、拍照、中断恢复的验收**。前台亮屏使用；锁屏／切后台、来电、浏览器回收、设备存储额度和网络故障会影响录制，页面会呈现可检测的状态。不会把自动测试冒充真机验收。

## 安装与 GitHub

优先提供发布后的插件链接，点击安装／连接即可；使用时可以一句话唤起。

**不能承诺 iPhone ChatGPT 能凭一句话从任意 GitHub 仓库安装插件。** 官方 GitHub 导入有工作区管理和平台范围限制；Desktop only 插件不能据此变成手机版插件。这个仓库提供可审查的源码，不绕过安装确认、权限授权或托管服务。

若以后将本源码放到 GitHub，可向有代码执行和部署工具的助手发：

> 读取这个仓库的 README 和 AGENTS，部署为我自己的私有课伴 Site，启用 MCP，并给我安装链接。不要使用额外模型 API，也不要声称已完成 iPhone 真机验收。

这是一句**部署任务描述**，不是平台保证的手机安装指令。新部署必须注册自己的 Site；不得沿用另一个所有者的 `project_id`。本仓库当前 `.openai/hosting.json` 绑定本次私有 Site，所有凭据均不在源码中。

## 本地运行

需要 Node.js 22 或更新版本；无需 `npm install`。

```sh
node scripts/build.mjs
node --test tests/*.test.mjs
node scripts/dev.mjs
```

打开 <http://127.0.0.1:8787>。本地服务仅监听回环地址，开发身份只由 `scripts/dev.mjs` 注入，部署的 Worker 不含开发登录旁路。本地数据在被 Git 忽略的 `.data/`；手机访问需要 HTTPS 线上地址。

## 托管

Cloudflare Worker ESM；`.openai/hosting.json` 声明 Sites 私有身份与 `BUCKET` R2 绑定。`node scripts/build.mjs` 将前端文本嵌入单个 Worker，输出 `dist/server/index.js`。零运行时依赖、无外部字体、CDN、分析 SDK；构建报告在 `dist/build-report.json`。

标准／扩展 MCP 方法：`server/discover`、`initialize`、`tools/list`、`tools/call`、`resources/list`、`resources/read`。公开工具：`open_classroom`、`list_lessons`、`get_lesson`、`read_photo`、`save_lesson_notes`；`app_request` 仅供界面使用。

当前 GPT 整理策略：分页查看所有相关照片，用时间作线索并结合前后讲稿；不静默丢图；照片原文、老师讲解、AI 补充分别标注；模糊公式保留原图并标出不确定处；无照片讲解单独保留。

## 参考与许可

本实现没有复制 Nojoin／NoteV 的源代码。产品与工程参考：

- [NoteV](https://github.com/DearBobby9/NoteV_Glasses)：课堂照片与语音时间组织。
- [Nojoin](https://github.com/Valtora/Nojoin)：网页收音、时间轴、MCP 的分工。
- [CourseNoteStudio](https://github.com/prpcabsr/CourseNoteStudio)：讲稿与板书共同组织。
- [OpenAI 插件文档](https://developers.openai.com/plugins)：公开插件桥接与工具协议。

本源码 MIT，见 LICENSE。Sites 服务与 ChatGPT 的账户、访问与使用条件独立适用。

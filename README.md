# 两只老虎 · 音乐体验（网页版）

打开网页即进入 voice App 的「音乐体验」页面，播放《两只老虎》，并让震动跟随音频的能量变化。

- 单页，没有标签栏、没有音乐库列表、没有「弹奏」模式
- 进去就是播放页；浏览器若拒绝自动播放，会显示「开始体验」按钮（同时解锁音频与震动）
- 震动逻辑照搬 `voice` 项目：`AudioHapticSignal` 的包络与对比度、`ExperienceModel` 的逐帧 tick、`HapticEngine` 的连续通道与瞬态脉冲
- **没有修改 `voice` 目录里的任何文件**，只读取了 `两只老虎.mp3` 和已发布的听写结果 `liang-zhi-lao-hu.json`

## 打开方式

推荐直接双击 `index.html`（`file://`）。也可以在项目根目录起一个静态服务器：

```bash
cd "/Users/heyya/Downloads/体验web"
python3 -m http.server 8765 --bind 127.0.0.1
# 然后访问 http://127.0.0.1:8765/index.html
```

目前本机已有一个后台静态服务器在跑：<http://127.0.0.1:8765/index.html>（进程可直接结束，页面本身不依赖它）。

**关于震动**：Web 只有 `navigator.vibrate()`，**Android Chrome 可用**，iOS Safari 和桌面浏览器都拿不到马达。在无法震动的设备上：

- 画面中的「马达指令」会把手机马达将要执行的震动窗口画出来（每一柱 = 一个 100 ms 窗口，通电越久强度越大）；这就是同一份震动数据
- 打开「无震动设备时用低频声代替」，同样的强度会变成音频里的低频脉冲（默认关闭）

## 文件

```
index.html                  唯一页面（音乐体验，歌曲体验模式）
assets/styles.css           voice/Design/Theme.swift 的 CSS 版本（颜色、圆角、字号、间距、深浅色）
assets/audio-haptic-signal.js  AudioHapticSignal.swift 的逐行移植
assets/haptic-engine.js        HapticEngine.swift 的 Web 版（Vibration API 翻译层）
assets/experience-model.js     ExperienceModel.swift（歌曲体验）的移植
assets/app.js                  视图层：节拍光球、电平波形、马达指令、进度与播放控制
assets/tactile-tone.js         低频声代替震动（仅在打开开关时使用）
data/song-data.js           听写音符时间轴 + 离线测得的音量包络（60 帧/秒）
data/audio-data.js          音频的 base64 备份，仅在相对路径加载失败时载入（2 MB）
audio/liang-zhi-lao-hu.mp3  录音副本（只读自 /Users/heyya/voice/两只老虎.mp3）
scripts/generate-data.py    重新生成 data/ 下两个文件
scripts/verify-model.js     无需浏览器即可跑通整条震动链路并做断言
```

## 震动是怎么实现的

`voice` 的 HapticEngine 用 Core Haptics：一个持续播放的 continuous 事件，每帧重发 intensity/sharpness；脉冲则用 transient 事件。Web 的 Vibration API 只能给「开/关毫秒数组」，没有振幅参数，所以最后一层做了等价翻译（`assets/haptic-engine.js` 顶部有完整注释）：

| voice（Core Haptics） | 网页（Vibration API） |
| --- | --- |
| `updateAudio(intensity, sharpness)` 持续通道，逐帧调参 | 每 100 ms 一个马达窗口，窗口内的**通电占空比**表示强度；sharpness 高时同一窗口拆成两次短促点击 |
| `playPulse(intensity)` 瞬态事件 | 一次 16–62 ms 的短震，期间接管马达 |
| 音频静音 → `stopAudio()` | `navigator.vibrate(0)`，并停止窗口定时器 |

翻译层之上的部分与 App 完全一致：

- 包络：`target = ((dB+48)/48)^1.5`，起音 0.025 s / 释音 0.075 s（`AudioHapticSignal.update`）
- 对比度：绕 0.5 展开，1× 为原始动态，范围 1…2.5（`HapticSettings`，网页版同样记住设置）
- 强度下限 0.02，静音（平均电平 ≤ −48 dB）直接停震
- 峰值与平均的差值映射到 sharpness：`0.15 + min(1,(peak−avg)/18) × 0.7`
- 滴答循环、播放/暂停/拖动、页面切到后台自动暂停，都与 `ExperienceModel.tick` 一致

唯一的替换是「表头来源」：App 每帧问 `AVAudioPlayer` 要 `averagePower` / `peakPower`；网页版从 `data/song-data.js` 里读取**同一段录音**离线测得的同样两个数字（每 1/60 秒一帧，多声道取最响的一条，和 Swift 里的 `.max()` 相同）。这样双击本地文件打开也能得到和 App 一致的动态，不依赖浏览器能否解码分析音频。

## 网页版新增的三处（App 里没有）

1. **马达指令**面板：把震动流画成时间条，没有马达的设备也能「看到」震动节奏
2. **低频声代替**开关：给无法震动的设备一个可感知的替代通道
3. **开始体验闸门**：浏览器要求用户手势才能出声、震动，只有在自动播放被拒绝时才出现

其余界面元素都来自 App：节拍光球（`BeatOrb`）、84 格电平波形（`LevelWaveform`）、进度条与从头播放/播放按钮（`ExperienceView.transport`）、震动对比度滑块（`SettingsSheet`）、以及「此设备暂时无法提供震动，仍可播放音频和查看画面。」等原文案。

按需求删掉的部分：标签栏（学习/音乐/创作/我的）、音乐库列表页、关闭按钮，以及「弹奏」模式。听写出来的 267 个音符仍然保留在 `data/song-data.js` 里 —— App 的歌曲体验模式本来就用它在音符切换时给波形和进度条换色（`Theme.tint(for:)`），这里保持同样的行为。

小屏（如 iPhone 竖屏）上，光球至少保留 200 px 高度，右侧面板上半部分可滚动，**播放控制始终固定可见**。

## 校验

无需浏览器：

```bash
node scripts/verify-model.js
```

它会用假的窗口/音频/马达时钟逐帧播完整首歌，并断言：每 ~100 ms 一个马达窗口、静音即停震、对比度越高峰值越大而中间段落越弱、占空比随强度单调上升、暂停释放马达并清空波形、拖动与恢复播放正常。

真实 WebKit（iOS 18.7 模拟器，iPhone 17，402×714 @3x）实测：无 JS 报错，`overflowX = 0`，光球 140 px 居中、波形 84 格全部有值、进度条与播放按钮完整可见（未越过视口），音频 `readyState = 4`、时长 94.77 s；把音频路径改坏后 base64 备份能接管（`data:audio/mpeg;base64,…` 同样 `readyState = 4`）。

重新生成数据（会读取 `voice` 的资源，但不写入）：

```bash
python3 scripts/generate-data.py
```

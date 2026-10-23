# custom-watermark-template

Meow Star Map 自定义水印模板示例插件。

## 功能

向 Meow Star Map 的水印面板注入 3 个示例水印模板：

| 模板 ID         | 名称         | 类型     | 说明                                     |
| --------------- | ------------ | -------- | ---------------------------------------- |
| `cwt-festival`  | 节日纪念水印 | 图片水印 | 使用 `templates/festival.svg` 作为水印图 |
| `cwt-signature` | 个人签名水印 | 文字水印 | 粉色签名风格文字 `© My Nikki Gallery`    |
| `cwt-datestamp` | 当日日期戳   | 文字水印 | 动态生成当日日期 `YYYY-MM-DD`            |

## 安装

### 方式一：从源码打包安装

```bash
cd plugins-samples/custom-watermark-template
npm pack
# 生成 custom-watermark-template-1.0.0.tgz
```

然后在 Meow Star Map 设置 → 插件管理 → 安装插件，输入 .tgz 文件路径。

### 方式二：直接从目录安装

在插件管理界面输入本目录路径（pluggable-electron 支持目录形式安装）。

## 权限声明

- `watermark:apply` — 仅申请水印相关能力

## 扩展点

- `watermark.template` — 注册 3 个水印模板

## 目录结构

```
custom-watermark-template/
├── package.json
├── index.js              ← 插件入口
├── templates/
│   └── festival.svg      ← 节日水印图片资源
├── locales/
│   ├── zh-CN.json
│   └── en-US.json
└── README.md
```

## 开发参考

完整插件 API 文档见 [`docs/PLUGIN_API.md`](../../docs/PLUGIN_API.md)。

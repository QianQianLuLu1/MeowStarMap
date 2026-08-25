# 无限暖暖相册扫描器实施计划

---

## 一、项目概述

实现《无限暖暖》多发行渠道（官方启动器版 > Steam版 > Epic版）相册资源的自动扫描、UID账号隔离索引、原生缩略图复用能力，兼容官方相册与本地截图路径的差异化处理逻辑。

---

## 二、核心依赖声明

### 运行时依赖

1. Python 3.10+（支持模式匹配、类型提示增强）
2. 第三方库：
   - `pywin32`：Windows注册表读取（定位各渠道游戏安装路径）
   - `sqlalchemy`：轻量级SQLite索引存储
   - `watchdog`：可选，用于后续增量扫描扩展
   - `Pillow`：可选，用于ScreenShot路径缩略图生成

### 复用优先说明

优先复用开源项目 [GamePhotoScanner](https://github.com/search?q=game+photo+scanner) 中的路径扫描、UID识别核心逻辑，无匹配开源方案时自行实现精简代码。

---

## 三、分阶段实施任务

### 阶段1：游戏根目录定位模块开发

#### 任务1.1：多渠道路径识别实现

- 修改文件：`src/path_resolver.py`
- 输入：无（自动扫描）/ 可选手动传入自定义根目录路径
- 输出：优先级匹配到的游戏根目录路径，匹配失败返回None
- 实现逻辑：
  1. 按优先级依次扫描官方启动器版、Steam版、Epic版的注册表/配置文件/默认路径
  2. 官方启动器版优先读取`HKLM\SOFTWARE\InfinityNikki Launcher`注册表项获取安装路径，失败则扫描默认安装目录、解析启动器配置文件、反向解析桌面快捷方式
  3. Steam版读取`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Steam App 2732520`注册表项获取安装路径
  4. Epic版读取Epic Games Launcher清单文件`C:\ProgramData\Epic\EpicGamesLauncher\Manifests`下对应条目获取安装路径
- 验收标准：三种渠道的路径识别成功率≥95%，高优先级渠道匹配成功后不再尝试低优先级渠道

#### 任务1.2：路径校验逻辑实现

- 修改文件：`src/path_resolver.py`
- 输入：待校验路径
- 输出：校验通过返回True，失败返回False
- 实现逻辑：校验路径是否存在、是否包含`X6Game\Saved\GamePlayPhotos`子目录、是否有读取权限
- 验收标准：无效路径、无权限路径100%被拦截，不进入后续扫描流程

---

### 阶段2：相册扫描与分类模块开发

#### 任务2.1：GamePlayPhotos目录强制扫描实现

- 修改文件：`src/album_scanner.py`
- 输入：游戏根目录路径
- 输出：所有UID目录下的资源路径集合，按UID分组
- 实现逻辑：
  1. 跳过隐藏属性过滤，强制遍历`GamePlayPhotos`目录及其所有子目录
  2. 自动识别纯数字命名的UID子目录，动态生成UID列表，不硬编码任何UID值
  3. 每个UID目录下按`NikkiPhotos_HighQuality`（高清图）、`NikkiPhotos_LowQuality`（原生缩略图）、其他自定义相册目录分类存储路径
- 验收标准：隐藏属性的GamePlayPhotos目录100%被扫描，不同UID资源完全隔离无混同

#### 任务2.2：ScreenShot路径独立扫描实现

- 修改文件：`src/album_scanner.py`
- 输入：游戏根目录路径
- 输出：ScreenShot目录下所有资源路径集合，独立标记为「本地截图」分类
- 实现逻辑：单独扫描`X6Game\ScreenShot`目录，不关联任何UID，保留原有缩略图生成逻辑
- 验收标准：ScreenShot资源与GamePlayPhotos资源完全分离，分类标记100%准确

---

### 阶段3：索引与缩略图处理模块开发

#### 任务3.1：原生缩略图复用逻辑实现

- 修改文件：`src/index_builder.py`
- 输入：扫描得到的资源路径集合
- 输出：SQLite索引数据库文件`album_index.db`
- 实现逻辑：
  1. GamePlayPhotos路径下的资源直接关联对应UID目录下的`NikkiPhotos_LowQuality`原生缩略图路径
  2. 全局禁用缩略图自动生成逻辑，不生成任何额外缩略图文件
- 验收标准：GamePlayPhotos路径下无新增缩略图文件，索引中缩略图路径100%指向原生低清图

#### 任务3.2：ScreenShot缩略图生成实现

- 修改文件：`src/index_builder.py`
- 输入：ScreenShot路径下的资源集合
- 输出：生成的缩略图文件存储在`./thumbnails/screenshot/`目录下，索引中关联对应缩略图路径
- 实现逻辑：使用Pillow库生成固定尺寸（256x256）的缩略图，存储为WebP格式
- 验收标准：ScreenShot路径下所有图片资源100%生成对应缩略图，索引关联正确

---

## 四、启动说明

### 前置条件

1. Python 3.10+ 环境已安装
2. 执行依赖安装命令：`pip install pywin32 sqlalchemy Pillow`

### 启动方式

1. 自动扫描模式：`python main.py --auto`
2. 手动指定根目录模式：`python main.py --root "D:\InfinityNikki Launcher\InfinityNikki"`
3. 查看帮助：`python main.py --help`

### 输出产物

1. 索引数据库：`./data/album_index.db`
2. 运行日志：`./logs/scanner.log`
3. ScreenShot缩略图：`./thumbnails/screenshot/`

---

## 五、错误处理规则

1. **路径不存在错误**：记录ERROR日志，提示用户检查游戏安装路径，自动尝试下一优先级渠道
2. **注册表读取失败错误**：记录WARN日志，自动降级到默认路径扫描方式
3. **权限不足错误**：记录ERROR日志，提示用户以管理员权限运行程序，跳过无权限目录
4. **文件读取错误**：记录WARN日志，跳过单个异常文件，不影响整体扫描流程
5. **索引写入错误**：记录ERROR日志，自动重试3次，失败后回滚当前事务，保证索引一致性

---

## 六、参数校验规则

1. `--root`参数校验：必须是合法Windows绝对路径，存在且包含`X6Game`子目录，否则抛出`ValueError`并提示
2. 无参数校验：默认按自动模式启动，按优先级扫描所有渠道路径
3. 自定义配置路径校验：如果指定了`--config`参数，必须是存在的`.yaml`/`.json`文件，配置项不符合要求时使用默认值并提示

---

## 七、基础测试用例

### 测试用例1：多渠道路径识别测试

- 输入：分别安装官方启动器版、Steam版、Epic版游戏
- 预期输出：优先返回官方启动器版路径，其次Steam版，最后Epic版
- 验证方式：单元测试覆盖率≥90%

### 测试用例2：UID资源隔离测试

- 输入：GamePlayPhotos目录下包含`123456`、`789012`两个UID子目录，每个目录下各有10张图片
- 预期输出：索引中两个UID的资源完全隔离，无交叉
- 验证方式：查询数据库统计每个UID的资源数量，与实际文件数量一致

### 测试用例3：缩略图处理测试

- 输入：GamePlayPhotos路径下包含高清图、原生缩略图，ScreenShot路径下包含20张截图
- 预期输出：GamePlayPhotos路径无新增缩略图，ScreenShot路径生成20个对应缩略图文件
- 验证方式：检查文件系统新增文件数量，查询索引中缩略图路径正确性

### 测试用例4：异常处理测试

- 输入：传入不存在的路径`Z:\invalid_path`
- 预期输出：程序提示路径无效，自动切换到自动扫描模式，无崩溃
- 验证方式：运行程序观察输出和日志

---

## 八、验证纪律

1. 每个模块开发完成后先执行单元测试，覆盖率≥85%方可进入下一模块开发
2. 集成测试覆盖所有核心流程，每个测试用例最多执行2次，失败后立即修复问题
3. 所有代码仅做1次审查，审查重点：是否符合需求规范、是否有性能隐患、错误处理是否完善，无严重缺陷立即通过推进下一步
4. 测试过程中发现的问题必须当场修复，不得遗留到后续阶段

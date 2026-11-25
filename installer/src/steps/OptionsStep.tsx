import { useEffect, useState } from 'react'
import type { InstallOptions, InstallerState } from '../types'

interface OptionsStepProps {
  state: InstallerState | null
  options: InstallOptions
  onBack: () => void
  onInstall: (options: InstallOptions) => void
}

const isAsciiPath = (value: string): boolean => /^[\x20-\x7E]+$/.test(value)

const OptionsStep = ({ state, options, onBack, onInstall }: OptionsStepProps): React.JSX.Element => {
  const initialDir = isAsciiPath(options.installDir)
    ? options.installDir
    : (state?.defaultInstallDir ?? '')
  const [installDir, setInstallDir] = useState(initialDir)
  const [createDesktopShortcut, setCreateDesktopShortcut] = useState(options.createDesktopShortcut)
  const [importCertificate, setImportCertificate] = useState(options.importCertificate)

  // 状态是异步加载的：若挂载时路径为空，等默认值/状态到达后补上，避免输入框一直空白
  useEffect(() => {
    if (installDir.trim() !== '' && isAsciiPath(installDir)) {
      return
    }
    const fallback = isAsciiPath(options.installDir)
      ? options.installDir
      : (state?.defaultInstallDir ?? '')
    if (fallback !== '' && fallback !== installDir) {
      setInstallDir(fallback)
    }
  }, [options.installDir, state?.defaultInstallDir, installDir])

  const disabled = installDir.trim() === ''

  return (
    <div>
      <h1>安装选项</h1>
      <p className="lead">
        {state?.mode === 'upgrade'
          ? '检测到已有安装，将覆盖升级到新版本；安装目录保持不变。'
          : '选择安装位置与附加选项，然后开始安装。'}
      </p>

      <div className="field">
        <label htmlFor="install-dir">安装目录</label>
        <input
          id="install-dir"
          type="text"
          value={installDir}
          onChange={(event) => setInstallDir(event.target.value)}
          placeholder="例如：C:\\Users\\你\\AppData\\Local\\Programs\\喵星图"
        />
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={createDesktopShortcut}
          onChange={(event) => setCreateDesktopShortcut(event.target.checked)}
        />
        创建桌面快捷方式
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={importCertificate}
          onChange={(event) => setImportCertificate(event.target.checked)}
        />
        导入自签名证书（后续更新不再提示未知发布者，需要用户确认）
      </label>

      <div className="actions">
        <button type="button" className="ghost" onClick={onBack}>
          上一步
        </button>
        <button
          type="button"
          className="primary"
          disabled={disabled}
          onClick={() =>
            onInstall({
              installDir: installDir.trim(),
              createDesktopShortcut,
              importCertificate
            })
          }
        >
          {state?.mode === 'upgrade' ? '开始覆盖安装' : '开始安装'}
        </button>
      </div>
    </div>
  )
}

export default OptionsStep

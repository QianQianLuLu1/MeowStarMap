import type { InstallerState } from '../types'

interface WelcomeStepProps {
  state: InstallerState | null
  error: string | null
  onNext: () => void
}

const WelcomeStep = ({ state, error, onNext }: WelcomeStepProps): React.JSX.Element => {
  return (
    <div>
      <h1>欢迎安装 喵星图</h1>
      <p className="lead">
        面向《无限暖暖》玩家的本地相册管理器。本向导将带你完成
        {state?.mode === 'upgrade' ? '覆盖安装' : state?.mode === 'repair' ? '修复安装' : '全新安装'}，
        所有照片与配置都保留在本机。
      </p>

      <div className="feature-grid">
        <div className="feature">
          <b>本地优先</b>
          图库、缩略图与数据库全部存放在本机，不上传云端。
        </div>
        <div className="feature">
          <b>覆盖升级</b>
          检测旧版本后原地覆盖，保留用户数据与设置。
        </div>
        <div className="feature">
          <b>签名与信任</b>
          可选导入自签名证书，后续更新包不再提示未知发布者。
        </div>
        <div className="feature">
          <b>可回滚</b>
          安装失败自动回滚到上一版本，不影响已有图库。
        </div>
      </div>

      {state?.installed === true && (
        <p className="lead">
          检测到已安装版本：{state.version ?? '未知'}，目录：{state.installDir ?? '未知'}。
        </p>
      )}

      {error !== null && <div className="error">读取安装状态失败：{error}</div>}

      <div className="actions">
        <button type="button" className="primary" onClick={onNext}>
          开始安装
        </button>
      </div>
    </div>
  )
}

export default WelcomeStep

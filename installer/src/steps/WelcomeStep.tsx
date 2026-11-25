import logo from '../assets/logo.png'
import type { InstallerState } from '../types'

interface WelcomeStepProps {
  state: InstallerState | null
  error: string | null
  onNext: () => void
}

const WelcomeStep = ({ state, error, onNext }: WelcomeStepProps): React.JSX.Element => {
  return (
    <div className="welcome">
      <div className="hero">
        <div className="hero-copy">
          <div className="hero-kicker">喵星图 · MeowStarMap</div>
          <h1 className="hero-title">
            欢迎安装
            <br />
            <span>喵星图</span>
          </h1>
          <p className="hero-lead">
            面向《无限暖暖》玩家的本地相册管理器。
            <br />
            所有照片与配置都保留在本机。
          </p>
          <div className="hero-platform">Windows 10 / 11 · x64</div>
          {state?.installed === true && (
            <p className="lead">
              检测到已安装版本：{state.version ?? '未知'}，目录：{state.installDir ?? '未知'}。
            </p>
          )}
        </div>
        <div className="hero-art">
          <img src={logo} alt="喵星图" />
        </div>
      </div>

      <div className="welcome-foot">
        <p className="hero-note">本地优先 · 覆盖升级 · 安装失败可回滚</p>
        {error !== null && <div className="error">读取安装状态失败：{error}</div>}
        <button type="button" className="primary hero-button" onClick={onNext}>
          开始安装
        </button>
      </div>
    </div>
  )
}

export default WelcomeStep

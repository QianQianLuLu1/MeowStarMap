const ProgressStep = (): React.JSX.Element => {
  return (
    <div>
      <h1>正在安装</h1>
      <p className="lead">正在准备安装文件，请不要关闭窗口。</p>

      <div className="progress-track">
        <div className="progress-fill" />
      </div>
      <p className="lead">安装进度会随步骤实时更新（当前为骨架阶段，进度事件即将接入）。</p>
    </div>
  )
}

export default ProgressStep

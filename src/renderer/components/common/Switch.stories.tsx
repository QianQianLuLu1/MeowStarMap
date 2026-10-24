import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { Switch } from './Switch'

const meta: Meta<typeof Switch> = {
  title: 'Common/Switch',
  component: Switch,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          '独立弹性开关：`.settings-elastic-switch` 裸控件封装。点击后 350ms 果冻滑动' +
          '（途中胶囊拉伸、终点回弹、轨道灰→绿渐变）；' +
          'role=switch，Space/Enter 可切换。设置行布局请用 SettingsToggle。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof Switch>

function InteractiveSwitch(): React.ReactElement {
  const [on, setOn] = useState(false)
  return <Switch checked={on} onChange={setOn} aria-label="受控开关" />
}

export const Off: Story = {
  args: { checked: false, 'aria-label': '示例开关' }
}

export const On: Story = {
  args: { checked: true, 'aria-label': '示例开关' }
}

export const Interactive: Story = {
  render: () => <InteractiveSwitch />
}

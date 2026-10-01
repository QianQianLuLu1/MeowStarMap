import type { Meta, StoryObj } from '@storybook/react-vite'
import { FormField } from './FormField'

const meta: Meta<typeof FormField> = {
  title: 'Common/FormField',
  component: FormField,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          '统一表单字段容器：label 上置 + helper/error 下置。error 以 role=alert 渲染，' +
          '并经 aria-invalid / aria-describedby 关联控件，补齐字段级校验态。'
      }
    }
  }
}

export default meta
type Story = StoryObj<typeof FormField>

export const WithHelper: Story = {
  render: () => (
    <FormField label="套装名称" htmlFor="story-outfit" helper="不超过 20 个字符">
      {(aria) => <input id="story-outfit" className="input-field" {...aria} />}
    </FormField>
  )
}

export const WithError: Story = {
  render: () => (
    <FormField label="套装名称" htmlFor="story-outfit-err" error="名称不能为空">
      {(aria) => <input id="story-outfit-err" className="input-field" {...aria} />}
    </FormField>
  )
}

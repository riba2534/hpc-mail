import { fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmailBodyBoundary, htmlToPlainText } from './body-error-boundary'

function BrokenInEffect(): null {
  useEffect(() => {
    throw new Error('sanitize exploded')
  }, [])
  return null
}

function BrokenInRender(): null {
  throw new Error('linkify exploded')
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('htmlToPlainText', () => {
  it('提取文字并按块换行，不含脚本与样式内容', () => {
    const html = '<style>.x{color:red}</style><div>您的账单<br>金额：<b>¥128</b></div><p>点击   查看</p><script>alert(1)</script>'
    expect(htmlToPlainText(html)).toBe('您的账单\n金额：¥128\n点击 查看')
  })
})

describe('EmailBodyBoundary', () => {
  it('正文渲染（含 effect 里）抛错时降级为纯文本，并给出下载 .eml 的入口', () => {
    const download = vi.fn()
    render(
      <>
        <h1>邮件主题</h1>
        <EmailBodyBoundary resetKey={1} text="纯文本正文" html="<p>html</p>" onDownloadRaw={download}>
          <BrokenInEffect />
        </EmailBodyBoundary>
      </>,
    )
    expect(screen.getByRole('heading', { name: '邮件主题' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('正文无法按原格式显示，已改为纯文本')
    expect(screen.getByText('纯文本正文')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '下载原始邮件 (.eml)' }))
    expect(download).toHaveBeenCalledOnce()
  })

  it('没有纯文本正文时从 HTML 提取文字；没有原始邮件时不显示下载入口', () => {
    render(
      <EmailBodyBoundary resetKey={1} text="" html="<table><tr><td>验证码 123456</td></tr></table>">
        <BrokenInRender />
      </EmailBodyBoundary>,
    )
    expect(screen.getByText('验证码 123456')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /下载原始邮件/ })).toBeNull()
  })

  it('换一封邮件时重新按原格式渲染', () => {
    const { rerender } = render(
      <EmailBodyBoundary resetKey={1} text="a">
        <BrokenInRender />
      </EmailBodyBoundary>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    rerender(
      <EmailBodyBoundary resetKey={2} text="b">
        <p>第二封的正文</p>
      </EmailBodyBoundary>,
    )
    expect(screen.getByText('第二封的正文')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

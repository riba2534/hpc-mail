import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { linkify, splitQuoteBlocks } from './linkify'
import { PlainTextBody } from './plain-text-body'

describe('linkify', () => {
  it('识别 http/https/mailto，并去掉句末标点与紧跟的中文', () => {
    expect(linkify('打开https://a.example/v?code=1。然后 mailto:me@a.example, 再看 (http://b.example/x).')).toEqual([
      { type: 'text', text: '打开' },
      { type: 'link', text: 'https://a.example/v?code=1', href: 'https://a.example/v?code=1' },
      { type: 'text', text: '。然后 ' },
      { type: 'link', text: 'mailto:me@a.example', href: 'mailto:me@a.example' },
      { type: 'text', text: ', 再看 (' },
      { type: 'link', text: 'http://b.example/x', href: 'http://b.example/x' },
      { type: 'text', text: ').' },
    ])
  })

  it('不转换其他协议', () => {
    expect(linkify('javascript:alert(1) data:text/html,x ftp://a.example file:///etc/passwd')).toEqual([
      { type: 'text', text: 'javascript:alert(1) data:text/html,x ftp://a.example file:///etc/passwd' },
    ])
  })
})

describe('splitQuoteBlocks', () => {
  it('连续「>」行归为一个引用块', () => {
    expect(splitQuoteBlocks('hi\n> a\n>b\n\nbye')).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'quote', lines: ['a', 'b'] },
      { type: 'text', text: '\nbye' },
    ])
  })
})

describe('PlainTextBody', () => {
  it('链接在新标签打开，HTML 片段按文本显示', () => {
    const { container } = render(<PlainTextBody text={'<img src=x onerror=alert(1)> https://a.example/path'} />)
    const link = screen.getByRole('link', { name: 'https://a.example/path' })
    expect(link).toHaveAttribute('href', 'https://a.example/path')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(container.querySelector('img')).toBeNull()
    expect(container).toHaveTextContent('<img src=x onerror=alert(1)>')
  })

  it('引用默认折叠，可展开与收起', () => {
    render(<PlainTextBody text={'回复内容\n> 原文第一行\n> 原文第二行'} />)
    expect(screen.queryByText(/原文第一行/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '显示引用内容（2 行）' }))
    expect(screen.getByText(/原文第一行/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '收起引用内容' }))
    expect(screen.queryByText(/原文第一行/)).toBeNull()
  })

  it('transformText 只替换非引用文字块，结果按纯文本渲染并照常识别链接', () => {
    const { container } = render(
      <PlainTextBody
        text={'Click https://a.example/x\n> quoted'}
        transformText={(text) => `<b>点击</b> ${text.replace('Click ', '')}`}
      />,
    )
    expect(container.querySelector('b')).toBeNull()
    expect(container).toHaveTextContent('<b>点击</b> https://a.example/x')
    expect(screen.getByRole('link', { name: 'https://a.example/x' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '显示引用内容（1 行）' }))
    expect(screen.getByText('quoted')).toBeInTheDocument()
  })
})

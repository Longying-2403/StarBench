import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { presetOffers, signInOffer } from '../../shared/provider-choices.ts'
import type { PresetOffer } from '../../shared/provider-choices.ts'
import { LOCAL_SERVERS } from '../../shared/types.ts'
import type { ProviderInfo } from '../../shared/types.ts'
import { ChevronDownIcon, PlusIcon } from './icons.tsx'
import { menuItems, moveInMenu } from './menu.ts'
import { roomStyle, useOutsidePress, usePopupPlace } from './util.ts'

/** What was picked: one of the services the app knows by name, the sign-in, a model server of one's own, or any other service. */
export type AddChoice = { type: 'preset'; offer: PresetOffer } | { type: 'signin' } | { type: 'local' } | { type: 'other' }

/**
 * The way to another model service, at the upper right of 设置 → 模型: a button, and under it
 * everything that can be added, in three groups. Picking an entry leads on to the page where it
 * is set up. What is there already says so and stays on offer: a service can be added again for
 * another key, and the sign-in leads to the one that exists.
 */
export function AddProviderMenu({ providers, onChoose }: { providers: readonly ProviderInfo[]; onChoose: (choice: AddChoice) => void }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // Three headings, five entries of one line and three of two; `.menu` sits 6px from the button.
  const place = usePopupPlace(open, triggerRef, 400, 6)

  const close = (refocus: boolean): void => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }
  useOutsidePress(open, rootRef, () => close(false))

  // The keyboard starts on the first entry.
  useEffect(() => {
    if (open) menuItems(menuRef.current)[0]?.focus({ preventScroll: true })
  }, [open])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
      return
    }
    moveInMenu(e, menuRef.current)
  }

  const choose = (choice: AddChoice): void => {
    // The page that follows takes the keyboard; the button is gone with the list.
    setOpen(false)
    onChoose(choice)
  }

  const signIn = signInOffer(providers)
  return (
    <div className="add-root" ref={rootRef}>
      <button ref={triggerRef} type="button" className="btn add-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((now) => !now)}>
        <PlusIcon />
        添加模型
        <ChevronDownIcon />
      </button>
      {open && (
        <div ref={menuRef} className="menu add-menu" role="menu" aria-label="添加模型" data-side={place.side} style={roomStyle(place)} onKeyDown={onKeyDown}>
          <div role="group" aria-labelledby="add-with-key">
            <div className="menu-label" id="add-with-key">
              用 API Key
            </div>
            {presetOffers(providers).map((offer) => (
              <button key={offer.preset.id} type="button" role="menuitem" className="menu-item" onClick={() => choose({ type: 'preset', offer })}>
                <span className="menu-item-text">
                  <span className="menu-item-name">{offer.preset.name}</span>
                </span>
                {offer.added && <span className="menu-item-tag">已添加</span>}
              </button>
            ))}
          </div>
          <div className="menu-divider" />
          <div role="group" aria-labelledby="add-with-account">
            <div className="menu-label" id="add-with-account">
              用账户登录
            </div>
            <button type="button" role="menuitem" className="menu-item" onClick={() => choose({ type: 'signin' })}>
              <span className="menu-item-text">
                <span className="menu-item-name">登录 OpenAI 账户</span>
                <span className="menu-item-path">用 ChatGPT 套餐的额度，不需要 API Key</span>
              </span>
              {signIn.signedIn && <span className="menu-item-tag">已登录</span>}
            </button>
          </div>
          <div className="menu-divider" />
          <div role="group" aria-labelledby="add-other">
            <div className="menu-label" id="add-other">
              其他
            </div>
            <button type="button" role="menuitem" className="menu-item" onClick={() => choose({ type: 'local' })}>
              <span className="menu-item-text">
                <span className="menu-item-name">本地模型</span>
                <span className="menu-item-path">{LOCAL_SERVERS.map((server) => server.name).join('、')}</span>
              </span>
            </button>
            <button type="button" role="menuitem" className="menu-item" onClick={() => choose({ type: 'other' })}>
              <span className="menu-item-text">
                <span className="menu-item-name">其他服务</span>
                <span className="menu-item-path">自己填接口地址和 API Key</span>
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

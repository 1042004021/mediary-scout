"use client";

import { useEffect, useRef } from "react";

/* Hallmark · component: support-dialog · genre: modern-minimal · theme: project (apps/web/DESIGN.md, Spotify)
 * states: trigger default · hover · focus-visible · dialog open · close (button / Esc / backdrop)
 * 设置页底部一行「请作者喝杯咖啡」，点开才出现两张收款码。不弹窗打扰，不进任何主流程。 */

export function SupportAuthorLink() {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // Clicking the backdrop (the dialog element itself, outside the panel) closes it.
    const onClick = (event: MouseEvent) => {
      if (event.target === dialog) dialog.close();
    };
    dialog.addEventListener("click", onClick);
    return () => dialog.removeEventListener("click", onClick);
  }, []);

  return (
    <>
      <button type="button" className="support-author-trigger" onClick={() => dialogRef.current?.showModal()}>
        觉得好用？请作者喝杯咖啡
      </button>
      <dialog ref={dialogRef} className="support-author-dialog" aria-labelledby="support-author-title">
        <div className="support-author-panel">
          <h2 id="support-author-title" className="support-author-title">
            请作者喝杯咖啡
          </h2>
          <p className="support-author-copy">
            Mediary Scout 是一个人业余做的开源项目，不收费、不做托管。如果它帮你省了时间，金额随意，一块也是鼓励。打赏不换任何额外功能。
          </p>
          <div className="support-author-codes">
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/support/wechat.png" alt="微信收款码" width={180} height={245} loading="lazy" />
              <figcaption>微信</figcaption>
            </figure>
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/support/alipay.png" alt="支付宝收款码" width={180} height={270} loading="lazy" />
              <figcaption>支付宝</figcaption>
            </figure>
          </div>
          <p className="support-author-note">
            备注里留个昵称，会整理进{" "}
            <a
              href="https://github.com/fancydirty/mediary-scout/blob/main/docs/support/thanks.md"
              target="_blank"
              rel="noopener noreferrer"
            >
              鸣谢名单
            </a>
            。
          </p>
          <button type="button" className="ghost-button support-author-close" onClick={() => dialogRef.current?.close()}>
            关闭
          </button>
        </div>
      </dialog>
    </>
  );
}

import { useRef, useState, type FormEvent } from "react";
import { Logo } from "../../components/Logo.tsx";
import { Toast, ToastViewport } from "../../components/Toast.tsx";
import { useI18n } from "../../i18n.tsx";

export interface LoginPageProps {
  readonly busy: boolean;
  readonly message: string;
  readonly readOnly?: boolean;
  readonly onUnlock: (token: string) => Promise<boolean>;
  readonly onDismissMessage: () => void;
}

/**
 * 围绕 Beautio 当前标签页有效的真实 Admin 密钥渲染 Figma 登录构图。
 * Renders the Figma login composition around Beautio's actual tab-scoped Admin key.
 *
 * @param props - 解锁状态、实时反馈与认证提交操作。 / Unlock state, live feedback, and the authenticated submit operation.
 * @returns 锁定态应用界面，不暗示尚未提供的账户登录能力。 / The locked application surface without implying unavailable account login.
 */
export function LoginPage({
  busy,
  message,
  readOnly = false,
  onUnlock,
  onDismissMessage,
}: LoginPageProps) {
  const { t } = useI18n();
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [localError, setLocalError] = useState("");
  const tokenRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const normalized = token.trim();
    if (normalized.length === 0) {
      setLocalError(t("请输入管理密钥。"));
      tokenRef.current?.focus();
      return;
    }
    setLocalError("");
    setToken("");
    setShowToken(false);
    void onUnlock(normalized).then((succeeded) => {
      if (!succeeded) tokenRef.current?.focus();
    });
  };
  const feedback = localError || (busy ? "" : message);

  return (
    <main className="relative flex min-h-dvh w-full items-center justify-center overflow-hidden bg-[linear-gradient(145deg,#F5F3F1_0%,#EEE8E5_40%,#EDE8EE_100%)] px-5 py-20">
      <div className="pointer-events-none absolute -right-[8%] -top-[12%] size-[55vw] min-h-80 min-w-80 rounded-full bg-[radial-gradient(circle,rgba(179,160,173,0.28)_0%,transparent_68%)]" />
      <div className="pointer-events-none absolute -bottom-[8%] -left-[6%] size-[48vw] min-h-72 min-w-72 rounded-full bg-[radial-gradient(circle,rgba(174,183,193,0.22)_0%,transparent_70%)]" />
      <div className="pointer-events-none absolute left-[8%] top-[35%] size-[28vw] min-h-48 min-w-48 rounded-full bg-[radial-gradient(circle,rgba(155,127,124,0.15)_0%,transparent_70%)]" />

      <section className="relative z-10 w-full max-w-[400px] rounded-3xl bg-white px-8 py-10 shadow-[0_8px_48px_rgba(90,76,74,0.10),0_2px_12px_rgba(90,76,74,0.06)] sm:px-9">
        <div className="mb-7 flex justify-center">
          <Logo className="h-16 w-auto object-contain" />
        </div>
        <p className="mb-8 text-center text-xs font-light tracking-[0.18em] text-[#B3A0AD]">
          {t("关于你，也关于时间")}
        </p>

        {readOnly ? (
          <div className="mb-6 rounded-2xl bg-[#EEF1F4] px-4 py-3 text-xs leading-relaxed text-[#4A6272]">
            {t("生产数据只读观察 · 请输入本机只读密钥。生产管理密钥不会进入浏览器。")}
          </div>
        ) : null}

        <form onSubmit={handleSubmit} noValidate>
          <div className="mb-6 border-b border-[#E5D8CF] opacity-45">
            <label htmlFor="account-placeholder" className="mb-2 block text-[10px] tracking-[0.14em] text-[#9B7F7C]">
              {t("邮箱 / 手机号")}
            </label>
            <input
              id="account-placeholder"
              type="text"
              disabled
              placeholder={t("账户登录即将开放")}
              className="w-full bg-transparent pb-3 text-sm font-light outline-none placeholder:text-stone-300"
            />
          </div>

          <div className="mb-3 border-b border-[#E5D8CF]">
            <label htmlFor="admin-token" className="mb-2 block text-[10px] tracking-[0.14em] text-[#9B7F7C]">
              {readOnly ? t("本机只读密钥") : t("管理密钥")}
            </label>
            <div className="flex items-center">
              <input
                ref={tokenRef}
                id="admin-token"
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={busy}
                placeholder={
                  readOnly ? t("输入本机只读密钥") : t("输入当前实例的管理密钥")
                }
                className="min-w-0 flex-1 bg-transparent pb-3 text-sm font-light text-[#5A4C4A] outline-none placeholder:text-stone-300 disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => setShowToken((visible) => !visible)}
                disabled={busy}
                className="pb-3 text-[11px] tracking-[0.06em] text-[#B3A0AD] transition-opacity hover:opacity-70 disabled:opacity-45"
                aria-pressed={showToken}
                aria-label={showToken ? t("隐藏管理密钥") : t("显示管理密钥")}
              >
                {showToken ? t("隐藏") : t("显示")}
              </button>
            </div>
          </div>

          <div className="mb-6 flex justify-end">
            <button type="button" disabled className="text-xs text-[#9B7F7C] opacity-40">
              {t("忘记密钥?")}
            </button>
          </div>

          <div className="mb-4 min-h-5" aria-hidden="true" />

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-full bg-[linear-gradient(120deg,#9B7F7C_0%,#B3A0AD_100%)] py-4 text-sm font-medium tracking-[0.22em] text-white transition-opacity hover:opacity-90 active:opacity-80 disabled:opacity-45"
          >
            {busy ? t("正在验证…") : t("进入 Beautio")}
          </button>

          <div className="my-6 flex items-center gap-4" aria-hidden="true">
            <div className="h-px flex-1 bg-[#EDE8E5]" />
            <span className="text-xs text-[#D5D2CF]">{t("或")}</span>
            <div className="h-px flex-1 bg-[#EDE8E5]" />
          </div>

          <p className="text-center text-sm font-light text-[#A8A3A0]">
            {t("还没有账户？")}
            <button type="button" disabled className="ml-1 font-medium text-[#9B7F7C] opacity-40">
              {t("立即注册")}
            </button>
          </p>
        </form>
      </section>

      <p className="absolute bottom-8 left-0 right-0 text-center text-[11px] tracking-[0.12em] text-[#C8C2BE]">
        Beauty in Flow
      </p>
      {feedback.length === 0 ? null : (
        <ToastViewport>
          <Toast
            message={feedback}
            onDismiss={localError.length > 0 ? () => setLocalError("") : onDismissMessage}
          />
        </ToastViewport>
      )}
    </main>
  );
}

import { type ConnectOutcome, useCompleteOAuth } from "@agenteschat/client";
import { errorCode, errorText } from "@agenteschat/client/lib/errors";
import { authorizeState, pastedReturn, pastedStart } from "@agenteschat/client/lib/pasted-return";
import {
  AffixInput,
  Button,
  DialogBody,
  DialogFooter,
  Field,
  Icon,
  Locked,
  onThemeChange,
  SettingNote,
} from "@agenteschat/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";

/** The authorization finished: the connection it made, and what connecting did. */
export interface PastedDone {
  connectionId: string;
  outcome: ConnectOutcome;
}

/** Its state is gone (expired or used): a new authorization is needed, with a new address to open. */
const RESTARTS = new Set(["oauth.link_expired", "oauth.link_used"]);

/**
 * Connecting a server that refused our callback and took only the loopback address (ADR 0016 addendum 2026-11-23):
 * the sign-in opens in another tab and ends on a page there that doesn't load; the person copies that page's address
 * and pastes it here, which finishes the connection. Before they leave, a drawing of that page shows what to copy.
 * While they are away the dialog waits; back on this tab with nothing pasted, it says so and holds the field ready.
 * The right address connects at once; anything else says what was expected. `onRestart`: the authorization expired
 * or was used, so a new one is asked for (`authorizeUrl` changes, what is on screen stays).
 */
export function ConnectPaste({
  name,
  authorizeUrl,
  redirectUri,
  note,
  onDone,
  onRestart,
  onClose,
}: {
  name: string;
  authorizeUrl: string;
  redirectUri: string;
  /** The footer's words before the person leaves and while connecting (who will be able to use it). */
  note: ReactNode;
  onDone: (done: PastedDone) => void;
  onRestart: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const complete = useCompleteOAuth(org.id);
  const [step, setStep] = useState<"intro" | "waiting" | "back">("intro");
  const [value, setValue] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [pasteFailed, setPasteFailed] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const tried = useRef<string | null>(null);
  const left = useRef(false);
  const read = pastedReturn(value, redirectUri, authorizeState(authorizeUrl));
  const busy = complete.isPending || complete.isSuccess;

  // Away on the service's page, then back on this tab with nothing connected: say so, with the field ready.
  useEffect(() => {
    if (step !== "waiting") return;
    const away = () => {
      if (document.visibilityState === "hidden" || !document.hasFocus()) left.current = true;
    };
    const back = () => {
      if (!left.current || document.visibilityState !== "visible") return;
      left.current = false;
      setStep("back");
    };
    document.addEventListener("visibilitychange", away);
    window.addEventListener("blur", away);
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => {
      document.removeEventListener("visibilitychange", away);
      window.removeEventListener("blur", away);
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("focus", back);
    };
  }, [step]);
  useEffect(() => {
    if (step === "back") field.current?.focus();
  }, [step]);

  // The right address connects at once, once: the same text isn't sent again after a refusal.
  useEffect(() => {
    if (read.kind !== "ok" || busy || tried.current === value) return;
    tried.current = value;
    setFailure(null);
    complete.mutate(
      { state: read.state, code: read.code },
      {
        onSuccess: (done) => onDone({ connectionId: done.connectionId, outcome: done.outcome ?? "connected" }),
        onError: (error) => {
          setFailure(errorText(t, error, i18n.language));
          if (RESTARTS.has(errorCode(error) ?? "")) onRestart();
        },
      },
    );
  }, [read, value, busy, complete, onDone, onRestart, t, i18n.language]);

  const paste = async () => {
    setPasteFailed(false);
    try {
      setValue((await navigator.clipboard.readText()).trim());
    } catch {
      setPasteFailed(true);
      field.current?.focus();
    }
  };

  const error =
    failure ??
    (read.kind === "other"
      ? t("connectFlow.paste.wrong", { start: pastedStart(redirectUri) })
      : read.kind === "refused"
        ? t("connectFlow.paste.refused", { name })
        : undefined);
  // Opening the service's page: a link, so the desktop app sends it to the browser as any other.
  const open = (label: string, primary: boolean) => (
    <Button asChild variant={primary ? "primary" : "link"}>
      <a
        href={authorizeUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => {
          left.current = false;
          setStep("waiting");
        }}
      >
        {label}
      </a>
    </Button>
  );

  if (step === "intro") {
    return (
      <>
        <DialogBody className="cflow__body">
          <p className="muted cflow__text">{t("connectFlow.paste.intro", { name })}</p>
          <PasteScene redirectUri={redirectUri} />
        </DialogBody>
        <DialogFooter bar note={note}>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          {open(t("connectFlow.paste.open", { name }), true)}
        </DialogFooter>
      </>
    );
  }

  const now = busy
    ? { mark: <Icon name="spinner" size={16} />, title: t("connectFlow.paste.connecting", { name }) }
    : step === "back" || error
      ? { mark: <Icon name="alert" size={16} />, title: t("connectFlow.paste.back") }
      : { mark: <Icon name="spinner" size={16} />, title: t("connectFlow.paste.waiting", { name }) };
  const text = busy
    ? t("connectFlow.paste.connectingText")
    : step === "back" || error
      ? t("connectFlow.paste.backText")
      : t("connectFlow.paste.waitingText");
  return (
    <>
      <DialogBody className="cflow__body">
        <div className="cflow-paste__now">
          <p className="cflow-paste__state ac-iconline" role="status">
            {now.mark}
            <span>{now.title}</span>
          </p>
          <p className="muted cflow__text">{text}</p>
        </div>
        {!busy && <PasteScene redirectUri={redirectUri} />}
        <Locked when={busy}>
          <Field label={t("connectFlow.paste.field")} id="cflow-paste" error={error}>
            <AffixInput
              ref={field}
              value={value}
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              onChange={(e) => {
                setValue(e.target.value);
                setFailure(null);
                setPasteFailed(false);
              }}
              action={
                !value.trim() && (
                  <Button variant="ghost" size="sm" icon="copy" onClick={() => void paste()}>
                    {t("connectFlow.paste.paste")}
                  </Button>
                )
              }
            />
          </Field>
        </Locked>
        {pasteFailed && <SettingNote icon="alert">{t("connectFlow.paste.pasteFailed")}</SettingNote>}
      </DialogBody>
      <DialogFooter
        bar
        note={
          busy ? (
            note
          ) : (
            <span className="cflow-paste__again">
              {t("connectFlow.paste.notOpened")} {open(t("connectFlow.paste.openAgain", { name }), false)}
            </span>
          )
        }
      >
        <Button disabled={busy} onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * The page that doesn't load, drawn the way the app draws its scenes: a browser window in pixels rising from a dithered
 * ground, its address selected as text is right before it is copied. The address and the page's words are real text,
 * so the person knows the page when they get there. Decorative for screen readers: the words around it say the same.
 */
function PasteScene({ redirectUri }: { redirectUri: string }) {
  const { t } = useTranslation();
  const ground = useRef<HTMLCanvasElement>(null);
  const url = new URL(redirectUri);
  useEffect(() => {
    const canvas = ground.current;
    if (!canvas) return;
    const paint = () => paintGround(canvas);
    paint();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(paint);
    resize?.observe(canvas);
    const offTheme = onThemeChange(paint);
    return () => {
      resize?.disconnect();
      offTheme();
    };
  }, []);
  return (
    <div className="cflow-paste">
      <div className="cflow-paste__scene" aria-hidden="true">
        <canvas ref={ground} className="cflow-paste__ground" />
        <div className="cflow-paste__win">
          <div className="cflow-paste__top">
            <span className="cflow-paste__dots">
              <i />
              <i />
              <i />
            </span>
            <span className="cflow-paste__addr">
              <span>{`${url.host}${url.pathname}?code=…&state=…`}</span>
            </span>
          </div>
          <div className="cflow-paste__page">
            <i />
            <span>{t("connectFlow.paste.unreachable")}</span>
          </div>
        </div>
      </div>
      <p className="cflow-paste__where">{t("connectFlow.paste.where")}</p>
    </div>
  );
}

/** Bayer 4×4 thresholds, the sky's dither. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
/** How far each tone of the ground goes from the surface toward the ink. */
const GROUND_MIX = [0, 0.035, 0.07, 0.11];
const CELL = 4;

/**
 * The ground under the window: the dialog's surface dithered toward its ink, deeper at the bottom and the sides, with a
 * few loose pixels in the upper part. Its colors are the theme's, read again on every repaint.
 */
function paintGround(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext?.("2d");
  if (!ctx) return;
  const w = Math.max(1, Math.ceil(canvas.clientWidth / CELL));
  const h = Math.max(1, Math.ceil(canvas.clientHeight / CELL));
  canvas.width = w;
  canvas.height = h;
  const style = getComputedStyle(canvas);
  const surface = rgbOf(ctx, style.getPropertyValue("--surface-raised"));
  const ink = rgbOf(ctx, style.getPropertyValue("--ink"));
  const tones = GROUND_MIX.map(
    (k) => `rgb(${surface.map((c, i) => Math.round(c + ((ink[i] ?? c) - c) * k)).join(",")})`,
  );
  const last = tones.length - 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.min(1, (y / h) * 0.75 + Math.abs(x / w - 0.5) * 0.5) * last;
      const lo = Math.floor(v);
      const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
      const loose = n - Math.floor(n) > 0.992 && y < h * 0.6;
      const tone = loose ? lo + 2 : v - lo > (BAYER[((y & 3) << 2) | (x & 3)] ?? 0.5) ? lo + 1 : lo;
      ctx.fillStyle = tones[Math.min(last, tone)] ?? tones[0] ?? "transparent";
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

/** A CSS color (any form the theme writes) as its red, green and blue, through the canvas's own parser. */
function rgbOf(ctx: CanvasRenderingContext2D, color: string): number[] {
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = "#000";
  ctx.fillStyle = color.trim() || "#000";
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

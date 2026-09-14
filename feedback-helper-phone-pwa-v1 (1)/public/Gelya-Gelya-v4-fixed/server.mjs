import express from "express";
import { chromium } from "playwright";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: "128kb" }));
app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"],
  maxAge: 0,
  etag: false,
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
}));

const jobs = new Map();
let browserPromise = null;

const SAT = {
  1: "Дуже незадоволений(-а)",
  2: "Незадоволений(-а)",
  3: "Ані задоволений(-а), ані незадоволений(-а)",
  4: "Задоволений(-а)",
  5: "Дуже задоволений(-а)"
};

const VALUE = {
  1: "Зовсім не погоджуюсь",
  2: "Скоріше не погоджуюсь",
  3: "В чомусь погоджуюсь, в чомусь ні",
  4: "Скоріше погоджуюсь",
  5: "Повністю погоджуюсь"
};

const REVISIT = {
  1: "Дуже малоймовірно",
  2: "Малоймовірно",
  3: "Ані ймовірно, ані малоймовірно",
  4: "Ймовірно",
  5: "Дуже ймовірно"
};

const allowedReasons = new Set([
  "Швидкість обслуговування",
  "Привітність персоналу",
  "Якість їжі та/або напоїв",
  "Чистота",
  "Інше (будь ласка, уточніть)"
]);

function normalizePreset(input = {}) {
  const clamp = v => Math.max(1, Math.min(5, Number(v) || 5));
  const mainReason = allowedReasons.has(input.mainReason)
    ? input.mainReason
    : "Швидкість обслуговування";

  return {
    satisfaction: clamp(input.satisfaction),
    orderCorrect: input.orderCorrect !== false,
    mainReason,
    mainReasonOther: String(input.mainReasonOther || "").slice(0, 500),
    valueForMoney: clamp(input.valueForMoney),
    revisit: clamp(input.revisit),
    visitComment: String(input.visitComment || "").slice(0, 1200),
    employeeComment: String(input.employeeComment || "").slice(0, 1200)
  };
}

function validSurveyUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "https:"
      && u.hostname === "feedback.mcdonalds.com"
      && u.pathname.startsWith("/jfe/form/SV_");
  } catch {
    return false;
  }
}

function publicJob(job) {
  return {
    id: job.id,
    state: job.state,
    progress: job.progress,
    status: job.status,
    detail: job.detail,
    log: job.log.slice(-12),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

function update(job, progress, status, detail = "", logLine = "") {
  job.progress = Math.max(job.progress || 0, Math.min(100, progress));
  job.status = status;
  job.detail = detail;
  job.updatedAt = Date.now();
  if (logLine && job.log[job.log.length - 1] !== logLine) {
    job.log.push(logLine);
  }
  if (job.log.length > 30) job.log.splice(0, job.log.length - 30);
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"]
    }).catch(err => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

async function wait(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function visibleBodyText(page) {
  return (await page.locator("body").innerText({ timeout: 8000 }).catch(() => ""))
    .replace(/\s+/g, " ")
    .trim();
}

async function questionContainer(page, questionText) {
  const exact = page.getByText(questionText, { exact: false }).filter({ visible: true }).first();
  if (!(await exact.count())) return null;

  const handle = await exact.elementHandle();
  if (!handle) return null;

  const container = await handle.evaluateHandle(el => {
    let cur = el;
    for (let i = 0; i < 8 && cur; i++, cur = cur.parentElement) {
      const txt = (cur.innerText || "").trim();
      const inputs = cur.querySelectorAll("input,textarea,button,[role=radio],[role=option],label").length;
      if (txt.length < 2200 && inputs > 0) return cur;
    }
    return el.parentElement || el;
  });

  return container.asElement();
}

async function clickTextOnPage(page, text, questionText = null) {
  const roleRadio = page.getByRole("radio", { name: text, exact: true }).first();
  if (await roleRadio.count()) {
    await roleRadio.click({ timeout: 2500 }).catch(() => {});
    if (await roleRadio.isChecked().catch(() => true)) return true;
  }

  const label = page.locator("label").filter({ hasText: text }).first();
  if (await label.count()) {
    await label.click({ timeout: 2500 }).catch(() => {});
    return true;
  }

  if (questionText) {
    const container = await questionContainer(page, questionText);
    if (container) {
      const ok = await container.evaluate((el, wanted) => {
        const norm = s => (s || "").replace(/\s+/g, " ").trim();
        const nodes = [...el.querySelectorAll("label,button,[role=radio],[role=option],li,div")];
        let hit = nodes.find(n => norm(n.innerText) === wanted);
        if (!hit) hit = nodes.find(n => norm(n.innerText).includes(wanted));
        if (!hit) return false;

        const input = hit.matches?.("input") ? hit : hit.querySelector?.("input[type=radio],input[type=checkbox]");
        const target = input || hit;
        target.scrollIntoView?.({ block: "center" });
        target.click?.();
        target.dispatchEvent?.(new Event("input", { bubbles: true }));
        target.dispatchEvent?.(new Event("change", { bubbles: true }));
        return true;
      }, text).catch(() => false);
      await container.dispose().catch(() => {});
      if (ok) return true;
    }
  }

  const any = page.getByText(text, { exact: true }).first();
  if (await any.count()) {
    await any.click({ timeout: 2500 }).catch(() => {});
    return true;
  }

  return false;
}

async function fillTextQuestion(page, questionText, value) {
  if (!value) return true;
  const container = await questionContainer(page, questionText);
  if (!container) return false;

  const ok = await container.evaluate((el, value) => {
    const field = el.querySelector("textarea,input[type=text]");
    if (!field) return false;

    const proto = field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(field, value);
    else field.value = value;

    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    field.dispatchEvent(new Event("blur", { bubbles: true }));
    return true;
  }, value).catch(() => false);

  await container.dispose().catch(() => {});
  return ok;
}

async function clickNext(page) {
  const candidates = [
    page.getByRole("button", { name: /наступна сторінка/i }).first(),
    page.getByRole("button", { name: /далі/i }).first(),
    page.getByRole("button", { name: /next/i }).first(),
    page.getByRole("button", { name: /почати|розпочати|start/i }).first(),
    page.locator("#NextButton").first(),
    page.locator('input[type="button"][value*="Наступна" i]').first(),
    page.locator('input[type="submit"][value*="Наступна" i]').first(),
    page.locator('input[type="submit"][value*="Далі" i]').first(),
    page.locator('input[type="submit"][value*="Next" i]').first()
  ];

  for (const loc of candidates) {
    if (await loc.count()) {
      const visible = await loc.isVisible().catch(() => false);
      if (visible) {
        await Promise.allSettled([
          page.waitForLoadState("domcontentloaded", { timeout: 5000 }),
          loc.click({ timeout: 3500 })
        ]);
        return true;
      }
    }
  }

  return false;
}

function introText(text) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("дякуємо, що завітали до mcdonald") ||
    t.includes("опитування займе лише кілька хвилин") ||
    (t.includes("мова українська") && t.includes("наступна сторінка"))
  );
}

function completionText(text) {
  const t = text.toLowerCase();
  return t.includes("дякуємо, що поділились позитивними враженнями")
    || t.includes("дякуємо за ваш відгук")
    || t.includes("thank you for your feedback");
}

async function runSurvey(job) {
  let context = null;

  try {
    update(job, 5, "Відкриваю анкету…", "", "QR OK");
    const browser = await getBrowser();

    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: "uk-UA",
      userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36"
    });

    const page = await context.newPage();
    page.setDefaultTimeout(5000);

    page.on("dialog", d => d.dismiss().catch(() => {}));

    await page.goto(job.url, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    update(job, 12, "Сесію створено", "Починаю проходження.", "Survey opened");

    const p = job.preset;
    let samePageCount = 0;
    let previousSignature = "";

    for (let step = 0; step < 24; step++) {
      if (job.cancelled) throw new Error("Зупинено користувачем");

      await wait(650);
      const text = await visibleBodyText(page);

      if (completionText(text)) {
        job.state = "done";
        update(job, 100, "Готово", "Анкету завершено.", "completion=100");
        return;
      }

      if (!text) {
        if (step < 4) {
          update(job, Math.max(job.progress, 13), "Чекаю Qualtrics…", `Завантаження ${step + 1}/4`, "");
          continue;
        }
        throw new Error("Qualtrics відкрив порожню сторінку");
      }

      if (introText(text)) {
        update(job, 17, "Вступна сторінка", "Переходжу до питань…", "Intro page detected");
        const next = await clickNext(page);
        if (!next) throw new Error("Бачу вступну сторінку, але не знайшов кнопку «Наступна сторінка»");
        update(job, 20, "Переходжу до питань…", "Qualtrics завантажує перше питання.", "Intro passed");
        samePageCount = 0;
        previousSignature = "";
        await wait(700);
        continue;
      }

      const signature = `${page.url()}|${text.slice(0, 500)}`;
      if (signature === previousSignature) samePageCount++;
      else samePageCount = 0;
      previousSignature = signature;

      let handled = false;
      let progress = 15;
      const actions = [];

      if (text.includes("Загалом, наскільки ви задоволені")) {
        const ok = await clickTextOnPage(
          page,
          SAT[p.satisfaction],
          "Загалом, наскільки ви задоволені"
        );
        if (!ok) throw new Error("Не знайшов варіант загальної оцінки");
        actions.push("Загальна оцінка");
        handled = true;
        progress = Math.max(progress, 28);

        if (p.visitComment && text.includes("Розкажіть, будь ласка, що вплинуло на вашу оцінку")) {
          const filled = await fillTextQuestion(
            page,
            "Розкажіть, будь ласка, що вплинуло на вашу оцінку",
            p.visitComment
          );
          if (!filled) throw new Error("Не знайшов поле коментаря до оцінки");
          actions.push("Коментар");
        }
      }

      if (text.includes("Чи все було правильно у вашому замовленні")) {
        const ok = await clickTextOnPage(
          page,
          p.orderCorrect ? "Так" : "Ні",
          "Чи все було правильно у вашому замовленні"
        );
        if (!ok) throw new Error("Не знайшов Так/Ні для замовлення");
        actions.push("Правильність замовлення");
        handled = true;
        progress = Math.max(progress, 44);
      }

      if (text.includes("Чим ви найбільше задоволені")) {
        const ok = await clickTextOnPage(
          page,
          p.mainReason,
          "Чим ви найбільше задоволені"
        );
        if (!ok) throw new Error("Не знайшов вибраний пункт «Чим задоволені»");
        actions.push("Основний плюс");
        handled = true;
        progress = Math.max(progress, 58);

        if (p.mainReason.startsWith("Інше") && p.mainReasonOther) {
          const otherFilled = await page.locator('input[type="text"],textarea').last()
            .fill(p.mainReasonOther, { timeout: 2000 })
            .then(() => true)
            .catch(() => false);
          if (!otherFilled) throw new Error("Не знайшов поле для «Інше»");
          actions.push("Уточнення «Інше»");
        }
      }

      if (text.includes("співвідношення ціни та якості")) {
        const ok = await clickTextOnPage(
          page,
          VALUE[p.valueForMoney],
          "співвідношення ціни та якості"
        );
        if (!ok) throw new Error("Не знайшов оцінку ціна/якість");
        actions.push("Ціна / якість");
        handled = true;
        progress = Math.max(progress, 72);
      }

      if (text.includes("наступних 30 днів")) {
        const ok = await clickTextOnPage(
          page,
          REVISIT[p.revisit],
          "наступних 30 днів"
        );
        if (!ok) throw new Error("Не знайшов оцінку повернення");
        actions.push("Повернення");
        handled = true;
        progress = Math.max(progress, 86);
      }

      if (text.includes("відзначити працівника за обслуговування")) {
        if (p.employeeComment) {
          const filled = await fillTextQuestion(
            page,
            "відзначити працівника за обслуговування",
            p.employeeComment
          );
          if (!filled) throw new Error("Не знайшов поле працівника/коментаря");
        }
        actions.push("Фінальний коментар");
        handled = true;
        progress = Math.max(progress, 95);
      }

      if (handled) {
        update(job, progress, actions[actions.length - 1], "", actions.join(" + "));
        await wait(300);

        const next = await clickNext(page);
        if (!next) {
          const afterText = await visibleBodyText(page);
          if (completionText(afterText)) {
            job.state = "done";
            update(job, 100, "Готово", "Анкету завершено.", "completion=100");
            return;
          }
          throw new Error("Не знайшов кнопку «Далі»");
        }

        await wait(550);
        continue;
      }

      const validation = await page.locator(
        '.ValidationError,.validation-error,[role="alert"],.ErrorMessage'
      ).filter({ visible: true }).first().innerText().catch(() => "");

      if (validation?.trim()) {
        throw new Error(`Qualtrics: ${validation.trim().slice(0, 250)}`);
      }

      if (samePageCount < 8) {
        const heartbeat = Math.min(24, Math.max(job.progress, 13 + samePageCount));
        update(job, heartbeat, "Чекаю наступний крок…", `Qualtrics завантажує сторінку (${samePageCount + 1}/8)`, "");
        continue;
      }

      throw new Error(`Невідомий екран: ${text.slice(0, 320)}`);
    }

    throw new Error("Анкета не завершилась за допустиму кількість кроків");
  } catch (err) {
    if (job.cancelled) {
      job.state = "cancelled";
      update(job, 100, "Зупинено", "", "Cancelled");
    } else {
      job.state = "error";
      update(job, 100, "Потрібна перевірка", String(err?.message || err), "Automation stopped");
    }
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "gelya-gelya", version: "4.0", ts: Date.now() });
});

app.get("/api/health/browser", async (_req, res) => {
  try {
    const browser = await getBrowser();
    res.json({ ok: true, browser: await browser.version(), ts: Date.now() });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err), ts: Date.now() });
  }
});

app.post("/api/jobs", async (req, res) => {
  const surveyUrl = String(req.body?.surveyUrl || "").trim();
  if (!validSurveyUrl(surveyUrl)) {
    return res.status(400).json({ error: "Невірне посилання анкети" });
  }

  const id = crypto.randomUUID();
  const job = {
    id,
    state: "running",
    progress: 0,
    status: "Старт…",
    detail: "",
    log: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    url: surveyUrl,
    preset: normalizePreset(req.body?.preset),
    cancelled: false
  };

  jobs.set(id, job);
  runSurvey(job).catch(err => {
    job.state = "error";
    update(job, 100, "Помилка", String(err?.message || err), "Unhandled runner error");
  });

  res.status(202).json(publicJob(job));
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(publicJob(job));
});

app.delete("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  job.cancelled = true;
  res.json({ ok: true });
});

app.get("*", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.updatedAt < cutoff) jobs.delete(id);
  }
}, 10 * 60 * 1000).unref();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Геля-Геля v4 listening on ${PORT}`);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEvent, parseMine, summarize, isBot, describeUA, language, MAX_SECONDS } from "../track.js";

const ok = { event: "load", slug: "mami-king", visitor: "a1b2c3d4e5f6a1b2c3d4e5f6", session: "ffeeddccbbaa99887766" };

test("accepts a valid beacon and fills defaults", () => {
  const e = parseEvent(ok);
  assert.equal(e.slug, "mami-king");
  assert.equal(e.internal, false);
  assert.equal(e.ref, null);
  assert.equal(e.seconds, 0);
});

test("rejects bad events, slugs and ids", () => {
  assert.equal(parseEvent(null), null);
  assert.equal(parseEvent("load"), null);
  assert.equal(parseEvent({ ...ok, event: "delete" }), null);
  for (const slug of ["", "Mami-King", "../etc", "a--b", "-a", "a/b", "admin", "api", "x".repeat(81), 5]) {
    assert.equal(parseEvent({ ...ok, slug }), null, `slug ${slug}`);
  }
  for (const id of ["short", "has space here!!", "x".repeat(41), 12345678]) {
    assert.equal(parseEvent({ ...ok, visitor: id }), null, `visitor ${id}`);
    assert.equal(parseEvent({ ...ok, session: id }), null, `session ${id}`);
  }
});

test("cleans optional fields", () => {
  const e = parseEvent({
    ...ok,
    event: "time",
    internal: "true",
    ref: "maria<script>",
    tz: "America/Los_Angeles",
    referrer: "https://l.instagram.com/?u=https%3A%2F%2Fwebburrito.com",
    seconds: 1e9,
    scroll: -5,
  });
  assert.equal(e.internal, false, "only boolean true counts as internal");
  assert.equal(e.ref, null);
  assert.equal(e.tz, "America/Los_Angeles");
  assert.equal(e.referrer, "l.instagram.com");
  assert.equal(e.seconds, MAX_SECONDS);
  assert.equal(e.scroll, 0);
  assert.equal(parseEvent({ ...ok, ref: "sms-1", internal: true }).ref, "sms-1");
  assert.equal(parseEvent({ ...ok, referrer: "not a url" }).referrer, null);
});

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  iphoneInstagram:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 389.0.0.36.83 (iPhone15,3; iOS 18_5; en_US; en; scale=3.00; 1290x2796; 7301)",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; SM-S918U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  androidSamsung:
    "Mozilla/5.0 (Linux; Android 14; SM-S918U) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  androidFacebook:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0.0.0;]",
  iphoneMessenger:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/MessengerForiOS;FBAV/480.0;FBBV/1;FBDV/iPhone15,3;FBMD/iPhone;FBSN/iOS;FBSV/18.5]",
  kakao:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.8.0",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  winEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
};

test("describes devices, browsers and in-app browsers", () => {
  assert.deepEqual(describeUA(UA.iphoneSafari), { device: "iPhone", browser: "Safari", app: null });
  assert.deepEqual(describeUA(UA.iphoneInstagram), { device: "iPhone", browser: "Safari", app: "Instagram" });
  assert.deepEqual(describeUA(UA.androidChrome), { device: "Android phone", browser: "Chrome", app: null });
  assert.deepEqual(describeUA(UA.androidSamsung), { device: "Android phone", browser: "Samsung Internet", app: null });
  assert.equal(describeUA(UA.androidFacebook).app, "Facebook");
  assert.equal(describeUA(UA.iphoneMessenger).app, "Messenger");
  assert.equal(describeUA(UA.kakao).app, "KakaoTalk");
  assert.deepEqual(describeUA(UA.macChrome), { device: "Mac", browser: "Chrome", app: null });
  assert.deepEqual(describeUA(UA.winEdge), { device: "Windows PC", browser: "Edge", app: null });
});

test("flags bots but not real phones", () => {
  for (const ua of Object.values(UA)) assert.equal(isBot(ua), false, ua);
  for (const ua of [
    "",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36",
    "facebookexternalhit/1.1",
    "curl/8.5.0",
  ]) {
    assert.equal(isBot(ua), true, ua);
  }
});

test("reads the first Accept-Language tag", () => {
  assert.equal(language("es-US,es;q=0.9,en;q=0.8"), "es-US");
  assert.equal(language("ko"), "ko");
  assert.equal(language("*"), null);
  assert.equal(language(undefined), null);
});

test("parseMine accepts a visitor id and a true/false choice", () => {
  assert.deepEqual(parseMine({ visitor: ok.visitor, mine: true, token: "abc" }), { visitor: ok.visitor, mine: true, token: "abc" });
  assert.equal(parseMine({ visitor: ok.visitor, mine: false }).token, null);
  for (const b of [null, "x", {}, { visitor: ok.visitor }, { visitor: "short", mine: true }, { visitor: ok.visitor, mine: "yes" }]) {
    assert.equal(parseMine(b), null);
  }
  assert.equal(parseMine({ visitor: ok.visitor, mine: true, token: "x".repeat(5000) }).token, null);
});

test("summarize rebuilds totals and devices, skipping your own visits", () => {
  const visits = [
    { visitor: "aaaaaaaa", startedAt: 100, lastSeenAt: 160, unlocked: true, unlockedAt: 120, seconds: 40, failedTries: 1, device: "iPhone", browser: "Safari", app: null },
    { visitor: "aaaaaaaa", startedAt: 300, lastSeenAt: 400, unlocked: false, seconds: 0, failedTries: 0, device: "iPhone", browser: "Safari", app: "Instagram" },
    { visitor: "bbbbbbbb", startedAt: 200, lastSeenAt: 250, unlocked: true, unlockedAt: 210, seconds: 30, failedTries: 0, device: "Mac", browser: "Chrome", app: null },
    { visitor: "cccccccc", startedAt: 50, lastSeenAt: 900, unlocked: true, unlockedAt: 60, seconds: 99, failedTries: 3, internal: true },
  ];
  const { totals, visitors } = summarize(visits);
  assert.deepEqual(totals, {
    visits: 3, visitors: 2, opens: 2, failedTries: 1, seconds: 70,
    firstSeenAt: 100, lastSeenAt: 400, firstOpenedAt: 120, lastOpenedAt: 210,
  });
  assert.deepEqual(Object.keys(visitors).sort(), ["aaaaaaaa", "bbbbbbbb"]);
  assert.deepEqual(visitors.aaaaaaaa, { visits: 2, firstSeenAt: 100, lastSeenAt: 400, device: "iPhone", browser: "Safari", app: "Instagram" });
});

test("summarize returns null when only your own visits are left", () => {
  assert.equal(summarize([]), null);
  assert.equal(summarize([{ visitor: "cccccccc", startedAt: 1, lastSeenAt: 2, internal: true }]), null);
});

test("summarize works with Firestore-style timestamps", () => {
  const ts = (n) => ({ toMillis: () => n });
  const a = ts(5), b = ts(9);
  const { totals } = summarize([{ visitor: "aaaaaaaa", startedAt: a, lastSeenAt: b, unlocked: false }]);
  assert.equal(totals.firstSeenAt, a);
  assert.equal(totals.lastSeenAt, b);
  assert.equal("firstOpenedAt" in totals, false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEvent, isBot, describeUA, language, MAX_SECONDS } from "../track.js";

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

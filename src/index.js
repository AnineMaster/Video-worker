const DEFAULT_MEDIAFIRE_URL = 'https://www.mediafire.com/file/6xo1clqf7i01m29/video_single_hls_stream.mp4/file';

const CACHE_TTL_MS = 15 * 60 * 1000;
let cachedResolve = null;

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let val = Number(bytes);
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return val.toFixed(2) + ' ' + units[i];
}

function extractFilename(urlStr, disposition) {
  if (disposition) {
    const m = /filename\*?=(?:UTF-8'')?["']?([^"';\n]+)["']?/i.exec(disposition);
    if (m && m[1]) return decodeURIComponent(m[1].trim());
  }
  try {
    const u = new URL(urlStr);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch {}
  return 'video_stream.mp4';
}

async function resolveMediaFire(pageUrl, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedResolve && now - cachedResolve.fetchedAt < CACHE_TTL_MS) {
    return cachedResolve;
  }

  const pageRes = await fetch(pageUrl, {
    headers: BROWSER_HEADERS,
    redirect: 'follow',
  });
  if (!pageRes.ok) throw new Error('Source unavailable');

  const html = await pageRes.text();
  let directUrl = null;

  const scrambledMatch = /data-scrambled-url=["']([^"']+)["']/i.exec(html);
  if (scrambledMatch && scrambledMatch[1]) {
    try {
      const decoded = atob(scrambledMatch[1]);
      if (decoded.startsWith('http')) directUrl = decoded;
    } catch {}
  }
  if (!directUrl) {
    const directMatch = /href=["'](https:\/\/download\d+\.mediafire\.com\/[^"']+)["']/i.exec(html);
    if (directMatch && directMatch[1]) directUrl = directMatch[1];
  }
  if (!directUrl) {
    const btnMatch = /id=["']downloadButton["'][^>]*href=["']([^"']+)["']/i.exec(html);
    if (btnMatch && btnMatch[1] && btnMatch[1].startsWith('http')) directUrl = btnMatch[1];
  }
  if (!directUrl) throw new Error('Stream unavailable');

  let probe = await fetch(directUrl, {
    method: 'HEAD',
    headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'] },
    redirect: 'follow',
  });
  if (!probe.ok || !probe.headers.get('content-length')) {
    probe = await fetch(directUrl, {
      method: 'GET',
      headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'], Range: 'bytes=0-0' },
      redirect: 'follow',
    });
  }

  let contentLength = Number(probe.headers.get('content-length') || 0);
  const contentRange = probe.headers.get('content-range');
  if (contentRange) {
    const totalMatch = /\/(\d+)$/.exec(contentRange);
    if (totalMatch) contentLength = Number(totalMatch[1]);
  }

  const contentType = probe.headers.get('content-type') || 'video/mp4';
  const filename = extractFilename(directUrl, probe.headers.get('content-disposition'));

  cachedResolve = {
    directUrl,
    filename,
    contentLength,
    sizeFormatted: formatBytes(contentLength),
    contentType: contentType.startsWith('text/html') ? 'video/mp4' : contentType,
    fetchedAt: now,
  };
  return cachedResolve;
}

async function handleMediaProxy(request, pageUrl, isDownload) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type',
      },
    });
  }

  let info = await resolveMediaFire(pageUrl, false);
  const ua = request.headers.get('User-Agent') || '';
  const rangeHeader = request.headers.get('Range');
  const isSafari = /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|FxiOS|Android/i.test(ua);

  // Key Fix for 70+ Requests:
  // On /stream for Chrome/Android/Desktop, force ONE single 200 OK full-speed stream (Accept-Ranges: none)
  // so browser CANNOT spam 50-70 tiny Range requests! Keep 206 only for iOS/Safari & /download (1DM).
  const allowRange = isDownload || isSafari || rangeHeader === 'bytes=0-1';

  const buildHeaders = () => {
    const h = new Headers();
    h.set('User-Agent', BROWSER_HEADERS['User-Agent']);
    h.set('Accept', '*/*');
    if (allowRange && rangeHeader) h.set('Range', rangeHeader);
    return h;
  };

  let upstream = await fetch(info.directUrl, {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: buildHeaders(),
    redirect: 'follow',
  });

  const upType = upstream.headers.get('content-type') || '';
  if ((!upstream.ok && upstream.status !== 206) || upType.includes('text/html')) {
    info = await resolveMediaFire(pageUrl, true);
    upstream = await fetch(info.directUrl, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: buildHeaders(),
      redirect: 'follow',
    });
  }

  const outHeaders = new Headers();
  outHeaders.set(
    'Content-Type',
    upstream.headers.get('content-type') || info.contentType || 'video/mp4'
  );

  if (upstream.headers.get('content-length')) {
    outHeaders.set('Content-Length', upstream.headers.get('content-length'));
  }

  const safeName = info.filename.replace(/["\\]/g, '');
  if (isDownload) {
    outHeaders.set('Accept-Ranges', 'bytes');
    if (upstream.headers.get('content-range')) {
      outHeaders.set('Content-Range', upstream.headers.get('content-range'));
    }
    outHeaders.set('Content-Disposition', 'attachment; filename="' + safeName + '"');
    outHeaders.set('Cache-Control', 'no-store');
  } else {
    if (allowRange && upstream.status === 206) {
      outHeaders.set('Accept-Ranges', 'bytes');
      if (upstream.headers.get('content-range')) {
        outHeaders.set('Content-Range', upstream.headers.get('content-range'));
      }
    } else {
      outHeaders.set('Accept-Ranges', 'none');
    }
    outHeaders.set('Content-Disposition', 'inline; filename="' + safeName + '"');
    outHeaders.set('Cache-Control', 'public, max-age=86400');
  }

  outHeaders.set('Access-Control-Allow-Origin', '*');
  outHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: allowRange ? upstream.status : 200,
    headers: outHeaders,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pageUrl = (env && env.MEDIAFIRE_URL) || DEFAULT_MEDIAFIRE_URL;

    try {
      if (url.pathname === '/specs') {
        const cache = caches.default;
        const cacheKey = new Request(url.toString(), { method: 'GET' });
        const cached = await cache.match(cacheKey);
        if (cached) return cached;

        const info = await resolveMediaFire(pageUrl, false);
        const ext = (info.filename.split('.').pop() || 'MP4').toUpperCase();
        const res = new Response(
          JSON.stringify({
            title: info.filename.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' '),
            filename: info.filename,
            extension: ext,
            sizeFormatted: info.sizeFormatted,
            mimeType: info.contentType,
          }),
          {
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'public, max-age=600',
            },
          }
        );
        await cache.put(cacheKey, res.clone());
        return res;
      }

      if (url.pathname === '/stream') {
        return await handleMediaProxy(request, pageUrl, false);
      }

      if (url.pathname === '/download') {
        return await handleMediaProxy(request, pageUrl, true);
      }

      if (env && env.ASSETS) {
        return env.ASSETS.fetch(request);
      }
      return new Response('Not Found', { status: 404 });
    } catch {
      return new Response('Stream temporarily unavailable', { status: 502 });
    }
  },
};

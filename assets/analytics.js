/* gosandeep.com — site analytics (PostHog, project "Portfolio (gosandeep.com)")
 *
 * Same posture as Eagle's Descent:
 *  - pageviews + pageleave (gives scroll depth and time on page for blog posts)
 *  - no autocapture, no session recording, no heatmaps
 *  - localStorage persistence only (no cookies)
 *  - skipped on localhost / file:// unless ?analytics=debug is in the URL
 *
 * Custom events:
 *  - work_card_click  { project, href }            a work card's Open / Learn More button
 *  - outbound_click   { href, host, text, area }   any link leaving gosandeep.com (LinkedIn, GitHub, mailto, links in posts)
 */
(function () {
  var KEY = 'phc_BEEVDFWmcsJNw4A4QYTJfuzxMhMRNM5pbzkuWmpst7Pn';
  var HOST = 'https://us.i.posthog.com';

  var debug = /[?&]analytics=debug(&|$)/.test(location.search);
  var local = location.protocol === 'file:' ||
              /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(location.hostname);
  if (local && !debug) return;

  /* --- PostHog loader snippet (as provided in project settings) --- */
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog && window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}p||((p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",p.onerror=function(){p=null},(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r));var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],Object.defineProperty(u,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e}}),Object.defineProperty(u.people,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(){return u.toString(1)+".people (stub)"}}),o="su ru ou lu hu init Au Fu Eu Pu Nu zl Ru ju Tu Uu Wu Vu capture getExtension Ou iu Qu calculateEventProperties Zu register register_once register_for_session unregister unregister_for_session Xu Mu Ju getFeatureFlag getFeatureFlagPayload getFeatureFlagResult getAllFeatureFlags isFeatureEnabled reloadFeatureFlags updateFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSurveysLoaded onSessionId getSurveys getActiveMatchingSurveys renderSurvey displaySurvey cancelPendingSurvey canRenderSurvey canRenderSurveyAsync th identify setPersonProperties unsetPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset eh shutdown setIdentity clearIdentity get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException addExceptionStep captureLog startExceptionAutocapture stopExceptionAutocapture loadToolbar get_property getSessionProperty Ku zu createPersonProfile setInternalOrTestUser Yu cu du opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing get_explicit_consent_status is_capturing clear_opt_in_out_capturing Bu debug Ul $s getPageViewId captureTraceFeedback captureTraceMetric Su".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);

  window.posthog.init(KEY, {
    api_host: HOST,
    defaults: '2026-05-30',
    person_profiles: 'identified_only',
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_exceptions: false,
    disable_session_recording: true,
    persistence: 'localStorage',
    debug: debug
  });

  function track(name, props) {
    if (debug) { try { console.log('[analytics]', name, props); } catch (e) {} }
    try { window.posthog.capture(name, props, { transport: 'sendBeacon' }); } catch (e) {}
  }

  function areaOf(el) {
    if (el.closest('footer')) return 'footer';
    if (el.closest('article')) return 'post';
    if (el.closest('nav')) return 'nav';
    return 'page';
  }

  /* --- delegated click tracking --- */
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#') return;

    // Work cards: "Open" / "Learn More" buttons on the homepage
    if (a.classList.contains('card-btn')) {
      var card = a.closest('.card');
      var title = card && card.querySelector('.card-title');
      track('work_card_click', {
        project: title ? title.textContent.trim() : (a.getAttribute('aria-label') || href),
        href: a.href
      });
      return;
    }

    // Anything that leaves the site
    var url;
    try { url = new URL(a.href, location.href); } catch (e) { return; }
    var external = url.protocol === 'mailto:' || url.protocol === 'tel:' ||
                   (/^https?:$/.test(url.protocol) && url.hostname !== location.hostname);
    if (!external) return;
    track('outbound_click', {
      href: url.protocol === 'mailto:' ? 'mailto:' + url.pathname : url.href,
      host: url.protocol === 'mailto:' ? 'mailto' : url.hostname,
      text: (a.textContent || a.getAttribute('aria-label') || '').trim().slice(0, 80),
      area: areaOf(a)
    });
  }, true);
})();

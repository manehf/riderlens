(function () {
  "use strict";

  var GA_MEASUREMENT_ID = "G-XL3CSRXSNK";
  var META_PIXEL_ID = "1575516844369485";
  var CONSENT_KEY = "riderlens-analytics-consent-v1";
  var analyticsLoaded = false;

  function readConsent() {
    try {
      return window.localStorage.getItem(CONSENT_KEY);
    } catch (error) {
      return null;
    }
  }

  function writeConsent(value) {
    try {
      window.localStorage.setItem(CONSENT_KEY, value);
    } catch (error) {
      // The choice still applies for this page view when storage is unavailable.
    }
  }

  function loadScript(src, id) {
    if (document.getElementById(id)) return;
    var script = document.createElement("script");
    script.async = true;
    script.id = id;
    script.src = src;
    document.head.appendChild(script);
  }

  function initializeGoogleAnalytics() {
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () {
      window.dataLayer.push(arguments);
    };

    window.gtag("consent", "default", {
      analytics_storage: "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied"
    });
    window.gtag("consent", "update", { analytics_storage: "granted" });
    window.gtag("js", new Date());
    window.gtag("config", GA_MEASUREMENT_ID);

    loadScript(
      "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(GA_MEASUREMENT_ID),
      "riderlens-ga4"
    );
  }

  function initializeMetaPixel() {
    if (window.fbq) return;

    var fbq = function () {
      if (fbq.callMethod) {
        fbq.callMethod.apply(fbq, arguments);
      } else {
        fbq.queue.push(arguments);
      }
    };

    window.fbq = fbq;
    if (!window._fbq) window._fbq = fbq;
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = "2.0";
    fbq.queue = [];

    loadScript("https://connect.facebook.net/en_US/fbevents.js", "riderlens-meta-pixel");
    window.fbq("init", META_PIXEL_ID);
    window.fbq("track", "PageView");
  }

  function enableAnalytics() {
    if (analyticsLoaded) {
      if (window.gtag) window.gtag("consent", "update", { analytics_storage: "granted" });
      if (window.fbq) window.fbq("consent", "grant");
      return;
    }

    analyticsLoaded = true;
    initializeGoogleAnalytics();
    initializeMetaPixel();
  }

  function expireCookie(name, domain) {
    var suffix = domain ? "; domain=" + domain : "";
    document.cookie = name + "=; Max-Age=0; path=/; SameSite=Lax" + suffix;
  }

  function disableAnalytics() {
    if (window.gtag) window.gtag("consent", "update", { analytics_storage: "denied" });
    if (window.fbq) window.fbq("consent", "revoke");

    var hostname = window.location.hostname;
    var domain = hostname.indexOf(".") === -1 ? "" : "." + hostname.replace(/^www\./, "");
    document.cookie.split(";").forEach(function (cookie) {
      var name = cookie.split("=")[0].trim();
      if (name === "_fbp" || name === "_fbc" || name.indexOf("_ga") === 0) {
        expireCookie(name, "");
        if (domain) expireCookie(name, domain);
      }
    });
  }

  function getStoreDetails(link) {
    var href = link.href || "";
    if (href.indexOf("apps.apple.com") !== -1) return { store: "app_store", name: "App Store" };
    if (href.indexOf("play.google.com") !== -1) return { store: "google_play", name: "Google Play" };
    return null;
  }

  function getPlacement(link) {
    if (link.closest(".hero")) return "hero";
    if (link.closest(".download-band")) return "download_band";
    return "site";
  }

  function trackStoreClick(link, details) {
    if (!analyticsLoaded) return;

    var parameters = {
      store: details.store,
      store_name: details.name,
      placement: getPlacement(link),
      link_url: link.href
    };

    if (window.gtag) window.gtag("event", "store_click", parameters);
    if (window.fbq) window.fbq("trackCustom", "StoreClick", parameters);
  }

  function bindStoreClickTracking() {
    document.addEventListener("click", function (event) {
      var link = event.target.closest("a");
      if (!link) return;
      var details = getStoreDetails(link);
      if (details) trackStoreClick(link, details);
    });
  }

  function buildConsentBanner() {
    var banner = document.createElement("section");
    banner.className = "consent-banner";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-modal", "false");
    banner.setAttribute("aria-labelledby", "consent-title");
    banner.hidden = true;
    banner.innerHTML =
      '<div class="consent-banner__copy">' +
        '<strong id="consent-title">Help us improve RiderLens</strong>' +
        '<p>With your permission, Google Analytics and Meta Pixel measure visits and clicks to the App Store or Google Play. <a href="/privacy/#website-analytics">Learn more</a>.</p>' +
      '</div>' +
      '<div class="consent-banner__actions">' +
        '<button type="button" class="button-secondary" data-consent="rejected">Reject</button>' +
        '<button type="button" class="button-primary" data-consent="accepted">Accept analytics</button>' +
      '</div>';

    banner.addEventListener("click", function (event) {
      var button = event.target.closest("[data-consent]");
      if (!button) return;
      var value = button.getAttribute("data-consent");
      writeConsent(value);
      if (value === "accepted") enableAnalytics();
      else disableAnalytics();
      banner.hidden = true;
    });

    document.body.appendChild(banner);
    return banner;
  }

  function addSettingsButton(banner) {
    var supportNav = document.querySelector('.footer-nav[aria-label="Support links"]');
    if (!supportNav) return;

    var button = document.createElement("button");
    button.type = "button";
    button.className = "cookie-settings-button";
    button.textContent = "Cookie settings";
    button.addEventListener("click", function () {
      banner.hidden = false;
      var primaryAction = banner.querySelector('[data-consent="accepted"]');
      if (primaryAction) primaryAction.focus();
    });
    supportNav.appendChild(button);
  }

  function initialize() {
    var banner = buildConsentBanner();
    addSettingsButton(banner);
    bindStoreClickTracking();

    var consent = readConsent();
    if (consent === "accepted") enableAnalytics();
    else if (consent !== "rejected") banner.hidden = false;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize);
  } else {
    initialize();
  }
})();

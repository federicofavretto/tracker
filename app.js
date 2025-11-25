<script>
(function() {
  const TRACKER_ENDPOINT = "https://tracker-mhw8.onrender.com/collect";

  // ------------------ IDENTITÀ VISITATORE / SESSIONE ------------------
  function getOrCreateVisitorId() {
    try {
      let id = localStorage.getItem("lpdc_visitor_id");
      if (!id) {
        id = "v_" + Math.random().toString(36).substr(2, 9) + Date.now();
        localStorage.setItem("lpdc_visitor_id", id);
        localStorage.setItem("lpdc_first_visit_at", new Date().toISOString());
      }
      return id;
    } catch(e) {
      return null;
    }
  }

  function getOrCreateSessionId() {
    try {
      let id = sessionStorage.getItem("lpdc_session_id");
      if (!id) {
        id = "s_" + Math.random().toString(36).substr(2, 9) + Date.now();
        sessionStorage.setItem("lpdc_session_id", id);
      }
      return id;
    } catch(e) {
      return null;
    }
  }

  const visitorId = getOrCreateVisitorId();
  const sessionId = getOrCreateSessionId();

  function getDaysSinceFirstVisit() {
    try {
      const first = localStorage.getItem("lpdc_first_visit_at");
      if (!first) return null;
      const t0 = new Date(first).getTime();
      const t1 = Date.now();
      return Math.round((t1 - t0) / (1000 * 60 * 60 * 24));
    } catch(e) {
      return null;
    }
  }

  function isNewVisitorThisSession() {
    try {
      const flag = sessionStorage.getItem("lpdc_is_new_visitor");
      if (flag === "0" || flag === "1") return flag === "1";

      const first = localStorage.getItem("lpdc_first_visit_at");
      const isNew = !first;
      sessionStorage.setItem("lpdc_is_new_visitor", isNew ? "1" : "0");
      if (isNew) {
        localStorage.setItem("lpdc_first_visit_at", new Date().toISOString());
      }
      return isNew;
    } catch(e) {
      return false;
    }
  }

  // ------------------ UTILS ------------------
  function getDeviceType() {
    const ua = navigator.userAgent || "";
    if (/Mobile|Android|iP(hone|od)/i.test(ua)) return "mobile";
    if (/iPad|Tablet/i.test(ua)) return "tablet";
    return "desktop";
  }

  function parseUtm() {
    const params = new URLSearchParams(window.location.search || "");
    return {
      utm_source: params.get("utm_source") || null,
      utm_medium: params.get("utm_medium") || null,
      utm_campaign: params.get("utm_campaign") || null
    };
  }

  function sendEvent(payload) {
    try {
      const base = {
        sessionId,
        visitorId,
        isNewVisitor: isNewVisitorThisSession(),
        daysSinceFirstVisit: getDaysSinceFirstVisit(),
        url: window.location.href,
        path: window.location.pathname,
        referrer: document.referrer || "",
        deviceType: getDeviceType()
      };
      const utm = parseUtm();

      fetch(TRACKER_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify(Object.assign({}, base, utm, payload))
      }).catch(function(){});
    } catch(e) {}
  }

  // ------------------ PAGEVIEW + TIMEONPAGE ------------------
  window.addEventListener("DOMContentLoaded", function() {
    sendEvent({
      type: "pageview",
      title: document.title || ""
    });
  });

  (function(){
    let start = Date.now();
    function flushTimeOnPage() {
      const millis = Date.now() - start;
      if (millis > 500) {
        sendEvent({
          type: "timeonpage",
          millis: millis
        });
      }
    }
    window.addEventListener("beforeunload", flushTimeOnPage);
    document.addEventListener("visibilitychange", function() {
      if (document.visibilityState === "hidden") flushTimeOnPage();
    });
  })();

  // ------------------ VIEW_PRODUCT ENRICHED (solo pagina prodotto) ------------------
  {% if template contains 'product' and product %}
  window.addEventListener("DOMContentLoaded", function() {
    var productData = {
      id: {{ product.id | json }},
      title: {{ product.title | json }},
      price: {{ product.price | divided_by: 100.0 | json }},
      type: {{ product.type | json }},
      grams: {{ product.variants.first.weight | default: 0 | json }},
      inStock: {{ product.available | json }},
      currency: {{ shop.currency | json }}
    };

    sendEvent({
      type: "view_product",
      productId: productData.id,
      productTitle: productData.title,
      productCategory: productData.type,
      grams: productData.grams,
      productPrice: productData.price,
      currency: productData.currency,
      inStock: productData.inStock
    });

    // MEDIA INTERACTION (immagini/video prodotto)
    try {
      var images = document.querySelectorAll("img, [data-product-media]");
      images.forEach(function(img, idx) {
        img.addEventListener("click", function() {
          sendEvent({
            type: "media_interaction",
            mediaType: "image",
            action: "open",
            productId: productData.id,
            mediaPosition: idx + 1
          });
        });
      });
      var vids = document.querySelectorAll("video");
      vids.forEach(function(v, idx) {
        v.addEventListener("play", function() {
          sendEvent({
            type: "media_interaction",
            mediaType: "video",
            action: "play",
            productId: productData.id,
            mediaPosition: idx + 1
          });
        });
        v.addEventListener("ended", function() {
          sendEvent({
            type: "media_interaction",
            mediaType: "video",
            action: "end",
            productId: productData.id,
            mediaPosition: idx + 1
          });
        });
      });
    } catch(e) {}
  });
  {% endif %}

  // ------------------ CART_STATE + INTERCETTARE /cart ------------------
  async function sendCartState() {
    try {
      const res = await fetch("/cart.js", { credentials: "same-origin" });
      if (!res.ok) return;
      const cart = await res.json();
      var items = (cart.items || []).map(function(item) {
        return {
          productId: item.product_id,
          variantId: item.variant_id,
          quantity: item.quantity,
          productTitle: item.product_title,
          linePrice: item.line_price / 100.0
        };
      });

      sendEvent({
        type: "cart_state",
        items: items,
        totalPrice: cart.total_price ? cart.total_price / 100.0 : 0,
        currency: {{ shop.currency | json }}
      });
    } catch(e) {}
  }

// wrap fetch per intercettare SOLO le chiamate che modificano il carrello
(function() {
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    return origFetch(input, init).then(function(resp) {
      try {
        var url = typeof input === "string" ? input : (input.url || "");
        if (
          url.indexOf("/cart/add")   !== -1 ||
          url.indexOf("/cart/change")!== -1 ||
          url.indexOf("/cart/update")!== -1 ||
          url.indexOf("/cart/clear") !== -1 ||
          url.endsWith("/cart.js")
        ) {
          setTimeout(sendCartState, 500); // 0.5s dopo la modifica del carrello
        }
      } catch(e) {}
      return resp;
    });
  };
})();

// opzionale: puoi anche commentarlo per alleggerire ulteriormente
// setInterval(sendCartState, 60000); // ogni 60 secondi


  // ------------------ CHECKOUT_STEP (solo lato URL, best effort) ------------------
  function detectCheckoutStep() {
    var path = window.location.pathname || "";
    var step = null;
    var index = null;

    if (path.indexOf("/cart") !== -1) {
      step = "cart"; index = 1;
    } else if (path.indexOf("/checkout") !== -1) {
      // senza accesso a step Shopify, usiamo un best-effort
      step = "checkout"; index = 2;
    } else if (path.indexOf("/thank_you") !== -1 || path.indexOf("/thank-you") !== -1) {
      step = "thankyou"; index = 5;
    }

    if (step) {
      sendEvent({
        type: "checkout_step",
        step: step,
        stepIndex: index,
        cartValue: null,          // opzionale: puoi leggere da /cart.js se sei ancora nel dominio
        currency: {{ shop.currency | json }}
      });
    }
  }
  detectCheckoutStep();

  // ------------------ FORM / NEWSLETTER ------------------
  window.addEventListener("DOMContentLoaded", function() {
    // newsletter classico (puoi adattare i selettori ai tuoi form reali)
    var forms = document.querySelectorAll("form");
    forms.forEach(function(form) {
      var formId = form.getAttribute("id") || form.getAttribute("name") || "form_generic";

      form.addEventListener("submit", function() {
        sendEvent({
          type: "form_interaction",
          formId: formId,
          action: "submit"
        });
      });

      form.addEventListener("focusin", function() {
        sendEvent({
          type: "form_interaction",
          formId: formId,
          action: "focus"
        });
      });
    });
  });

  // ------------------ JS ERROR & PROMISE ERROR ------------------
  window.addEventListener("error", function(e) {
    try {
      sendEvent({
        type: "js_error",
        message: e.message || "",
        source: (e.filename || "").toString(),
        line: e.lineno || null,
        col: e.colno || null
      });
    } catch(_){}
  });

  window.addEventListener("unhandledrejection", function(e) {
    try {
      sendEvent({
        type: "js_error",
        message: (e.reason && e.reason.message) ? e.reason.message : "unhandledrejection",
        source: "promise",
        line: null,
        col: null
      });
    } catch(_){}
  });

  // ------------------ PERFORMANCE METRICS (LCP/FCP/TTFB best-effort) ------------------
  (function() {
    function sendPerf() {
      try {
        var perf = window.performance;
        if (!perf) return;

        var ttfb = 0;
        if (perf.getEntriesByType) {
          var navEntries = perf.getEntriesByType("navigation");
          if (navEntries && navEntries[0]) {
            ttfb = navEntries[0].responseStart;
          }
        }

        var fcp = 0;
        var lcp = 0;
        if ("getEntriesByType" in perf) {
          var paints = perf.getEntriesByType("paint") || [];
          paints.forEach(function(p) {
            if (p.name === "first-contentful-paint") {
              fcp = p.startTime;
            }
          });
        }

        if ("PerformanceObserver" in window) {
          try {
            var po = new PerformanceObserver(function(list) {
              var entries = list.getEntries();
              entries.forEach(function(entry) {
                if (entry.entryType === "largest-contentful-paint") {
                  lcp = entry.startTime;
                }
              });
            });
            po.observe({ type: "largest-contentful-paint", buffered: true });
          } catch(e) {}
        }

        setTimeout(function() {
          sendEvent({
            type: "perf_metric",
            lcp: lcp || null,
            fcp: fcp || null,
            ttfb: ttfb || null
          });
        }, 2000);
      } catch(e) {}
    }

    if (document.readyState === "complete") {
      sendPerf();
    } else {
      window.addEventListener("load", function() {
        sendPerf();
      });
    }
  })();

})();
</script>

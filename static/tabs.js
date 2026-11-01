/* Lanes | 3D stage tabs. Lanes is the default. The 3D stage tab shows /stage for the
   loaded piece in a frame; app.js keeps the tab's link pointing at that piece. */
"use strict";
(function () {
  const stageTab = document.getElementById("stage-tab");
  const frame = document.getElementById("stage-frame");
  const tabs = document.querySelectorAll("#tabs .tab");

  function pauseAll(doc) {
    try { doc.querySelectorAll("video, audio").forEach((m) => m.pause()); } catch (e) {}
  }

  function show(name) {
    tabs.forEach((t) => t.classList.toggle("on", t.dataset.tab === name));
    const stage = name === "stage";
    if (stage) {
      pauseAll(document);
      const url = document.getElementById("open-stage").getAttribute("href");
      if (url && frame.getAttribute("src") !== url) {
        frame.setAttribute("src", url);
        // An app window started before an update still runs the old server, which has no 3D stage.
        fetch("/stage").then((r) => {
          if (r.status !== 404) return;
          frame.removeAttribute("src");
          frame.srcdoc = '<body style="background:#000;color:#e8e8e8;font:16px/1.5 sans-serif;padding:40px">' +
            "<b>The app needs a restart to show the 3D stage.</b><br>" +
            "Close the Listening Lab window (the one with the server text), then start it again with run.bat or run.sh.</body>";
        }).catch(() => {});
      }
      const top = document.getElementById("top").getBoundingClientRect().bottom;
      document.documentElement.style.setProperty("--stage-top", top + "px");
    } else if (frame.contentDocument) {
      pauseAll(frame.contentDocument);
    }
    document.body.classList.toggle("stage-on", stage);
    stageTab.hidden = !stage;
    if (stage) setTimeout(() => frame.focus(), 50);
    else window.dispatchEvent(new Event("resize")); // let the lanes redraw at full size
  }

  tabs.forEach((t) => t.addEventListener("click", (e) => { e.preventDefault(); show(t.dataset.tab); }));
  // the 3D stage's own "← lanes" link comes back here instead of loading the page inside the frame
  window.addEventListener("message", (e) => {
    if (e.origin === location.origin && e.data === "show-lanes") show("lanes");
  });
  // keep the lanes page's keys (space = play) from acting on a hidden player
  document.addEventListener("keydown", (e) => {
    if (document.body.classList.contains("stage-on")) e.stopImmediatePropagation();
  }, true);
})();

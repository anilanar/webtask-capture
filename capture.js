"use latest";

import 'regenerator-runtime/runtime';
import 'isomorphic-fetch';
import express from 'express';
import { fromExpress } from 'webtask-tools';
import bodyParser from 'body-parser';
import session from 'cookie-session';
import basicAuth from 'express-basic-auth';
import sanitizer from 'express-sanitizer';
import lusca from 'lusca';
import dropbox from 'dropbox';

const app = express();
app.use((req, res, next) => {
  const { USERNAME, PASSWORD } = req.webtaskContext.secrets;
  basicAuth({
    users: { [USERNAME]: PASSWORD },
    challenge: true,
    realm: 'tasks/task-capture'
  })(req, res, next);
});
app.use(
  bodyParser.urlencoded({
    extended: false
  })
);
app.use(sanitizer());
app.use((req, res, next) => {
  const { secrets } = req.webtaskContext;
  session({
    secret: secrets.SESSION_SECRET
  })(req, res, next);
});
app.use(lusca({
  csrf: true,
  xframe: 'SAMEORIGIN',
  xssProtection: true
}));
app.use((req, res, next) => {
  req.context = {
    dbx: new dropbox.Dropbox({
      accessToken: req.webtaskContext.secrets.DBX_KEY
    }),
    domain: req.webtaskContext.secrets.AUTH0_DOMAIN
  };
  next();
});
const catchError = fn => (req, res) => {
  fn(req, res).catch(e => {
    console.log(e);
    res.status(500).send("An error has occured. Check logs.");
  });
};

app.get(
  "/",
  catchError(async (req, res) => {
    const list = await downloadList(req.context);
    const HTML = renderView({
      title: "My capture list",
      domain: req.context.domain,
      _csrf: res.locals._csrf,
      list
    });
    res.set("Content-Type", "text/html");
    res.status(200).send(HTML);
  })
);

app.post(
  "/",
  sanitizeItem,
  catchError(async (req, res) => {
    const url = req.original;
    const { item } = req.body;
    const list = await downloadList(req.context);
    list.push(item);
    await uploadList(list, req.context);
    redirect(req, res);
  })
);

app.post(
  "/delete/:index",
  catchError(async (req, res) => {
    const { index } = req.params;
    await deleteItem(index, req.context);
    redirect(req, res);
  })
);

module.exports = fromExpress(app);

function sanitizeItem(req, res, next) {
  req.body.item = req.sanitize(req.body.item);
  next();
}

function redirect(req, res) {
  res.redirect(req.context.domain);
}

async function downloadList({ dbx }) {
  let list;
  try {
    const { fileBinary } = await dbx.filesDownload({
      path: "/capture.json"
    });
    list = JSON.parse(fileBinary.toString("utf8")).list;
  } catch (e) {
    // path not found
    if (e.response.status !== 409) {
      throw e;
    }
    list = [];
    await uploadList(list, { dbx });
  }
  return list;
}

async function uploadList(list, { dbx }) {
  await dbx.filesUpload({
    path: "/capture.json",
    mode: "overwrite",
    contents: JSON.stringify({ list }),
    autorename: false,
    // sadly mute:true is ignored by dropbox
    mute: true
  });
}

async function deleteItem(index, { dbx }) {
  const list = await downloadList({ dbx });
  list.splice(index, 1);
  await uploadList(list, { dbx });
}

// function createSessionMiddleware(secret) {
//   return session({
//     secret,
//     resave: true,
//     saveUninitialized: true
//   });
// }

function renderView(locals) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>${locals.title}</title>
      <style>
        .item form {
          display: inline-block;
        }
      </style>
    </head>

    <body>
      <h1>Capture list</h1>
      <form action="${locals.domain}" method="post">
        <input type="hidden" name="_csrf" value="${locals._csrf}">
        <input type="text" name="item">
        <input type="submit" value="Add">
      </form>
      <ul>
        ${locals.list.map(renderItem(locals)).join("")}
      </ul>
    </body>
    </html>
  `;
}

function renderItem({ _csrf, domain }) {
  return (item, idx) => `
    <li class="item">
      ${item}
      <form action="${domain}/delete/${idx}" method="post">
        <input type="hidden" name="_csrf" value="${_csrf}">
        <input type="submit" value="&times;">
      </form>
    </li>
  `;
}
// Dolphin status overlays for the items in ONE.GY sync folders (KF5 and KF6).
// Asks the sync engine over its local socket (desktop/docs/engine-ipc.md
// "File manager integration"). Dolphin calls getOverlays() on its GUI
// thread: answer from the cache at once, ask the engine in batches and emit
// overlaysChanged() when its answers arrive. Nothing here ever blocks.
#include <KOverlayIconPlugin>

#include <QFile>
#include <QHash>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLocalSocket>
#include <QMessageAuthenticationCode>
#include <QRandomGenerator>
#include <QSet>
#include <QStandardPaths>
#include <QTimer>
#include <QUrl>

#include <utility>

namespace
{
const int kBatchMs = 50;
const int kMaxPaths = 1000; // files.status limit per call
const int kMaxCached = 50000;
const int kMaxLine = 16 * 1024 * 1024;
const int kRetryMinMs = 1000;
const int kRetryMaxMs = 15000;
}

class OnegyOverlayPlugin : public KOverlayIconPlugin
{
    Q_OBJECT
    Q_PLUGIN_METADATA(IID "gy.one.desktop.KOverlayIconPlugin" FILE "onegy-overlay.json")

public:
    explicit OnegyOverlayPlugin(QObject *parent = nullptr)
        : KOverlayIconPlugin(parent)
        , m_sock(new QLocalSocket(this))
    {
        m_batch.setSingleShot(true);
        m_batch.setInterval(kBatchMs);
        connect(&m_batch, &QTimer::timeout, this, &OnegyOverlayPlugin::flush);
        m_retry.setSingleShot(true);
        connect(&m_retry, &QTimer::timeout, this, &OnegyOverlayPlugin::connectEngine);
        connect(m_sock, &QLocalSocket::connected, this, &OnegyOverlayPlugin::hello);
        connect(m_sock, &QLocalSocket::readyRead, this, &OnegyOverlayPlugin::read);
        connect(m_sock, &QLocalSocket::disconnected, this, &OnegyOverlayPlugin::dropped);
        connect(m_sock, &QLocalSocket::errorOccurred, this, &OnegyOverlayPlugin::dropped);
    }

    QStringList getOverlays(const QUrl &url) override
    {
        if (!url.isLocalFile()) {
            return {};
        }
        QString path = url.toLocalFile();
        if (path.size() > 1 && path.endsWith(QLatin1Char('/'))) {
            path.chop(1);
        }
        if (!m_started) {
            m_started = true;
            connectEngine();
        }
        const auto it = m_state.constFind(path);
        if (it != m_state.constEnd()) {
            return overlaysFor(*it);
        }
        // shortcut: forgets every answer past kMaxCached paths; Dolphin asks again for what it shows.
        if (m_state.size() >= kMaxCached) {
            m_state.clear();
        }
        m_state.insert(path, QString());
        queue(path);
        return {};
    }

private:
    enum Call { Hello, Subscribe, Status };

    static QStringList overlaysFor(const QString &state)
    {
        if (state == QLatin1String("synced") || state == QLatin1String("syncing") || state == QLatin1String("error")
            || state == QLatin1String("paused")) {
            return {QStringLiteral("onegy-") + state};
        }
        return {};
    }

    // The socket and the key the engine proves itself with, from the
    // engine.json it writes once it listens (missing while it is not running).
    void connectEngine()
    {
        m_sock->abort();
        m_buf.clear();
        m_calls.clear();
        const QString dir = QStandardPaths::writableLocation(QStandardPaths::GenericDataLocation);
        QFile f(dir + QStringLiteral("/onegy/engine.json"));
        const QJsonObject info = f.open(QIODevice::ReadOnly) ? QJsonDocument::fromJson(f.read(64 * 1024)).object() : QJsonObject();
        const QString socket = info.value(QStringLiteral("socket")).toString();
        m_key = info.value(QStringLiteral("hello_key")).toString().toUtf8();
        if (socket.isEmpty() || m_key.isEmpty()) {
            retryLater();
            return;
        }
        m_sock->connectToServer(socket);
    }

    void retryLater()
    {
        if (!m_retry.isActive()) {
            m_retry.start(m_backoff);
            m_backoff = qMin(m_backoff * 2, kRetryMaxMs);
        }
    }

    void hello()
    {
        QByteArray nonce(16, Qt::Uninitialized);
        for (char &c : nonce) {
            c = char(QRandomGenerator::system()->bounded(256));
        }
        m_nonce = nonce.toHex();
        send(Hello, QStringLiteral("ipc.hello"), QJsonObject{{QStringLiteral("nonce"), QString::fromLatin1(m_nonce)}});
    }

    // Engine gone (or not the engine): no overlays until it is back.
    void dropped()
    {
        if (m_retry.isActive()) {
            return;
        }
        m_ready = false;
        m_queue.clear();
        for (auto it = m_state.begin(); it != m_state.end(); ++it) {
            const bool shown = !overlaysFor(*it).isEmpty();
            it->clear();
            if (shown) {
                Q_EMIT overlaysChanged(QUrl::fromLocalFile(it.key()), {});
            }
        }
        retryLater();
    }

    void send(Call call, const QString &method, const QJsonObject &params)
    {
        const int id = m_nextId++;
        m_calls.insert(id, call);
        QJsonObject req{{QStringLiteral("jsonrpc"), QStringLiteral("2.0")}, {QStringLiteral("id"), id}, {QStringLiteral("method"), method}};
        if (!params.isEmpty()) {
            req.insert(QStringLiteral("params"), params);
        }
        m_sock->write(QJsonDocument(req).toJson(QJsonDocument::Compact) + '\n');
    }

    void read()
    {
        m_buf += m_sock->readAll();
        int nl;
        while ((nl = m_buf.indexOf('\n')) >= 0) {
            const QByteArray line = m_buf.left(nl);
            m_buf.remove(0, nl + 1);
            handle(QJsonDocument::fromJson(line).object());
            if (m_sock->state() != QLocalSocket::ConnectedState) {
                return;
            }
        }
        if (m_buf.size() > kMaxLine) {
            m_sock->abort();
            dropped();
        }
    }

    void handle(const QJsonObject &msg)
    {
        if (msg.value(QStringLiteral("method")).toString() == QLatin1String("event")) {
            const QJsonObject params = msg.value(QStringLiteral("params")).toObject();
            if (m_ready && params.value(QStringLiteral("type")).toString() == QLatin1String("files")) {
                requeryUnder(params.value(QStringLiteral("data")).toObject().value(QStringLiteral("root")).toString());
            }
            return;
        }
        const int id = msg.value(QStringLiteral("id")).toInt();
        if (!m_calls.contains(id)) {
            return;
        }
        const Call call = m_calls.take(id);
        const QJsonObject result = msg.value(QStringLiteral("result")).toObject();
        if (call == Hello) {
            const QByteArray want =
                QMessageAuthenticationCode::hash(QByteArray("onegy-engine-hello:") + m_nonce, m_key, QCryptographicHash::Sha256).toHex();
            if (result.value(QStringLiteral("key_proof")).toString().toLatin1() != want) {
                qWarning("[ONEGY] the socket in engine.json is not the ONE.GY engine");
                m_sock->abort();
                dropped();
                return;
            }
            m_backoff = kRetryMinMs;
            m_ready = true;
            send(Subscribe, QStringLiteral("files.subscribe"), {});
            requeryUnder(QString());
        } else if (call == Status) {
            const QJsonArray items = result.value(QStringLiteral("items")).toArray();
            for (const QJsonValue &v : items) {
                const QJsonObject item = v.toObject();
                setState(item.value(QStringLiteral("path")).toString(), item.value(QStringLiteral("state")).toString());
            }
        }
    }

    void setState(const QString &path, const QString &state)
    {
        auto it = m_state.find(path);
        if (it == m_state.end() || *it == state) {
            return;
        }
        const QStringList before = overlaysFor(*it);
        *it = state;
        const QStringList after = overlaysFor(state);
        if (after != before) {
            Q_EMIT overlaysChanged(QUrl::fromLocalFile(path), after);
        }
    }

    // Every item Dolphin asked about under root ("" = all) again.
    void requeryUnder(const QString &root)
    {
        const QString prefix = root.endsWith(QLatin1Char('/')) ? root : root + QLatin1Char('/');
        for (auto it = m_state.constBegin(); it != m_state.constEnd(); ++it) {
            if (root.isEmpty() || it.key() == root || it.key().startsWith(prefix)) {
                queue(it.key());
            }
        }
    }

    void queue(const QString &path)
    {
        if (!m_ready) {
            return; // asked again once connected
        }
        m_queue.insert(path);
        if (!m_batch.isActive()) {
            m_batch.start();
        }
    }

    void flush()
    {
        QJsonArray paths;
        for (const QString &p : std::as_const(m_queue)) {
            paths.append(p);
            if (paths.size() == kMaxPaths) {
                send(Status, QStringLiteral("files.status"), QJsonObject{{QStringLiteral("paths"), paths}});
                paths = QJsonArray();
            }
        }
        if (!paths.isEmpty()) {
            send(Status, QStringLiteral("files.status"), QJsonObject{{QStringLiteral("paths"), paths}});
        }
        m_queue.clear();
    }

    QLocalSocket *m_sock;
    QTimer m_batch;
    QTimer m_retry;
    QByteArray m_buf;
    QByteArray m_key;
    QByteArray m_nonce;
    bool m_started = false;
    bool m_ready = false;
    int m_nextId = 1;
    int m_backoff = kRetryMinMs;
    QHash<int, Call> m_calls;
    QHash<QString, QString> m_state; // path Dolphin asked about -> engine state ("" = no answer yet)
    QSet<QString> m_queue;
};

#include "onegy-overlay.moc"

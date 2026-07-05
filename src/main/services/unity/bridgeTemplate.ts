/**
 * The C# editor bridge Cosmos installs into a Unity project
 * (Assets/Editor/CosmosBridge.cs). Runs an HTTP listener on
 * localhost:17890 inside the editor; main-thread work is marshaled
 * through EditorApplication.update.
 */
export const UNITY_BRIDGE_PORT = 17890

export const UNITY_BRIDGE_CSHARP = `// COSMOS editor bridge — installed by COSMOS. Safe to delete.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Net;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

[InitializeOnLoad]
public static class CosmosBridge
{
    const int Port = ${UNITY_BRIDGE_PORT};
    static readonly HttpListener listener = new HttpListener();
    static readonly ConcurrentQueue<Action> mainThreadQueue = new ConcurrentQueue<Action>();
    static readonly List<string> logBuffer = new List<string>();
    static readonly object logLock = new object();

    static CosmosBridge()
    {
        Application.logMessageReceived += OnLog;
        EditorApplication.update += Pump;
        try
        {
            listener.Prefixes.Add("http://127.0.0.1:" + Port + "/");
            listener.Start();
            var thread = new Thread(Listen) { IsBackground = true };
            thread.Start();
            Debug.Log("[CosmosBridge] listening on port " + Port);
        }
        catch (Exception e)
        {
            Debug.LogWarning("[CosmosBridge] failed to start: " + e.Message);
        }
    }

    static void OnLog(string condition, string stackTrace, LogType type)
    {
        lock (logLock)
        {
            logBuffer.Add("[" + type + "] " + condition);
            if (logBuffer.Count > 500) logBuffer.RemoveAt(0);
        }
    }

    static void Pump()
    {
        while (mainThreadQueue.TryDequeue(out var action))
        {
            try { action(); } catch (Exception e) { Debug.LogError("[CosmosBridge] " + e); }
        }
    }

    static string RunOnMainThread(Func<string> fn)
    {
        string result = null;
        Exception error = null;
        var done = new ManualResetEventSlim(false);
        mainThreadQueue.Enqueue(() =>
        {
            try { result = fn(); }
            catch (Exception e) { error = e; }
            finally { done.Set(); }
        });
        if (!done.Wait(15000)) return "ERROR: editor main thread timeout";
        if (error != null) return "ERROR: " + error.Message;
        return result ?? "";
    }

    static void Listen()
    {
        while (listener.IsListening)
        {
            HttpListenerContext ctx;
            try { ctx = listener.GetContext(); }
            catch { break; }
            ThreadPool.QueueUserWorkItem(_ => Handle(ctx));
        }
    }

    static void Handle(HttpListenerContext ctx)
    {
        string path = ctx.Request.Url.AbsolutePath.TrimEnd('/');
        string query = ctx.Request.QueryString["item"] ?? ctx.Request.QueryString["q"] ?? "";
        string body;
        switch (path)
        {
            case "/ping":
                body = RunOnMainThread(() =>
                    "{\\"ok\\":true,\\"project\\":\\"" + Application.productName +
                    "\\",\\"unity\\":\\"" + Application.unityVersion +
                    "\\",\\"playing\\":" + (EditorApplication.isPlaying ? "true" : "false") + "}");
                break;
            case "/console":
                lock (logLock) { body = string.Join("\\n", logBuffer.ToArray()); }
                if (body.Length == 0) body = "(console is empty)";
                break;
            case "/scene":
                body = RunOnMainThread(DumpScene);
                break;
            case "/play":
                body = RunOnMainThread(() => { EditorApplication.isPlaying = true; return "entering play mode"; });
                break;
            case "/stop":
                body = RunOnMainThread(() => { EditorApplication.isPlaying = false; return "exiting play mode"; });
                break;
            case "/refresh":
                body = RunOnMainThread(() => { AssetDatabase.Refresh(); return "asset database refreshed (scripts recompiling if changed)"; });
                break;
            case "/menu":
                string item = query;
                body = RunOnMainThread(() =>
                    EditorApplication.ExecuteMenuItem(item)
                        ? "executed menu item: " + item
                        : "ERROR: menu item not found: " + item);
                break;
            default:
                body = "ERROR: unknown endpoint " + path;
                break;
        }
        byte[] bytes = Encoding.UTF8.GetBytes(body);
        ctx.Response.ContentType = "text/plain; charset=utf-8";
        try
        {
            ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
            ctx.Response.Close();
        }
        catch { /* client went away */ }
    }

    static string DumpScene()
    {
        var scene = SceneManager.GetActiveScene();
        var sb = new StringBuilder();
        sb.AppendLine("Scene: " + scene.name + " (" + scene.path + ")");
        foreach (var root in scene.GetRootGameObjects()) DumpObject(root.transform, sb, 0);
        return sb.ToString();
    }

    static void DumpObject(Transform t, StringBuilder sb, int depth)
    {
        if (depth > 6 || sb.Length > 30000) return;
        var comps = t.gameObject.GetComponents<Component>();
        var names = new List<string>();
        foreach (var c in comps) if (c != null) names.Add(c.GetType().Name);
        sb.AppendLine(new string(' ', depth * 2) + t.name +
            (t.gameObject.activeInHierarchy ? "" : " (inactive)") +
            "  [" + string.Join(", ", names.ToArray()) + "]");
        foreach (Transform child in t) DumpObject(child, sb, depth + 1);
    }
}
`

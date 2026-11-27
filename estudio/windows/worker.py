"""Fila privada do Samuka Estúdio. Executar uma instância por fila."""
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from uuid import UUID

REMOTE = "samuka:"
CONFIG = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "SamukaEstudio"
ID = re.compile(r"[A-Za-z0-9_-]{1,160}")
PUBLIC_ERROR = "Confira a conexão, o espaço livre e a disponibilidade do vídeo. Detalhes no Windows."


def run(args):
    result = subprocess.run(args, capture_output=True, encoding="utf-8", errors="replace")
    if result.returncode:
        raise RuntimeError(result.stderr[-1500:] or "Ferramenta encerrou com erro.")
    return result.stdout


ERROS = [("Private video|unavailable|removed", "Vídeo indisponível ou privado."), ("Sign in|not a bot", "O YouTube pediu login. Atualize o yt-dlp e tente de novo."),
         ("No space left", "Sem espaço livre no disco."), ("Requested format|format is not available", "Qualidade indisponível para este vídeo.")]


def explain(text):
    return next((m for p, m in ERROS if re.search(p, text or "", re.I)), PUBLIC_ERROR)


def stream(args, on_tick):
    """Executa mostrando progresso; on_tick(pct, speed, eta) devolve True para cancelar."""
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding="utf-8", errors="replace")
    last, tail, t0 = "", [], 0
    for line in p.stdout:
        tail = (tail + [line])[-15:]
        m = re.match(r"PROG\s+([\d.]+)%\s+(\S+)\s+(\S+)", line)
        if m and time.time() - t0 > 5:
            t0 = time.time()
            if on_tick(float(m[1]), m[2], m[3]):
                p.kill(); p.wait(); raise InterruptedError("cancelado")
    if p.wait():
        raise RuntimeError("".join(tail))


def drive(folder, *args):
    if not isinstance(folder, str) or not ID.fullmatch(folder):
        raise ValueError("Pasta inválida.")
    return run(["rclone", *map(str, args), "--drive-root-folder-id", folder])


def read(queue, name):
    return json.loads(drive(queue, "cat", REMOTE + name))


def write(queue, job, data, temp):
    path = temp / "status.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    drive(queue, "copyto", path, REMOTE + "status-" + job + ".json", "--ignore-times")


def heartbeat(queue):
    while True:
        try:
            with tempfile.TemporaryDirectory(prefix="samuka-hb-") as d:
                f = Path(d) / "hb.json"
                f.write_text(json.dumps({"t": time.time()}), encoding="utf-8")
                drive(queue, "copyto", f, REMOTE + "heartbeat.json", "--ignore-times")
        except Exception:
            pass
        time.sleep(20)


def cancelled(queue, job):
    return bool(drive(queue, "lsf", REMOTE, "--include", f"cancel-{job}.json").strip())


def make_proxy(queue, job, source, temp):
    """Prévia 480p + miniatura + tira de quadros para a linha do tempo."""
    out, strip, thumb = temp / "proxy.mp4", temp / "strip.jpg", temp / "thumb.jpg"
    ff = ["ffmpeg", "-nostdin", "-loglevel", "error", "-y"]
    run(ff + ["-i", str(source), "-vf", "scale=-2:480", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
              "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", str(out)])
    dur = float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(out)]).strip())
    run(ff + ["-i", str(out), "-vf", f"fps=12/{max(dur, 1)},scale=-2:72,tile=12x1", "-frames:v", "1", str(strip)])
    run(ff + ["-ss", str(min(1, dur / 2)), "-i", str(out), "-frames:v", "1", "-vf", "scale=-2:96", str(thumb)])
    ids = {}
    for key, path, name in (("proxy", out, f"preview-{job}.mp4"), ("strip", strip, f"strip-{job}.jpg"), ("thumb", thumb, f"thumb-{job}.jpg")):
        drive(queue, "copyto", path, REMOTE + name)
        ids[key] = json.loads(drive(queue, "lsjson", "--stat", REMOTE + name))["ID"]
    return {**ids, "dur": dur}


def hms(v):
    v = int(v)
    return f"{v//60:02d}m{v%60:02d}s"


def clip(source, output, start, end):
    duration = float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "csv=p=0", str(source)]).strip())
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (start, end)) or not 0 <= start < end <= duration + 0.05:
        raise ValueError("Intervalo de corte inválido.")
    run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-ss", str(start), "-i", str(source),
         "-t", str(end-start), "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264",
         "-preset", "veryfast", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac",
         "-movflags", "+faststart", str(output)])


def process(queue, job, temp):
    data = read(queue, "job-" + job + ".json")
    dest = data["dest"]
    if not isinstance(dest, str) or not ID.fullmatch(dest) or dest == queue:
        raise ValueError("Pasta de destino inválida.")
    audio = data.get("q") == "audio"
    height = {"720": 720, "480": 480}.get(str(data.get("q")), 1080)
    output = temp / ("media.m4a" if audio else "media.mp4")
    extra = {}

    def tick(pct, speed, eta):
        write(queue, job, {"state": "Baixando", "pct": pct, "speed": speed, "eta": eta}, temp)
        return cancelled(queue, job)
    if data["type"] == "download":
        video = data["video"]
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video):
            raise ValueError("Identificador do YouTube inválido.")
        write(queue, job, {"state": "Baixando", "pct": 0}, temp)
        fmt = ["-x", "--audio-format", "m4a", "-f", "ba[ext=m4a]/ba"] if audio else [
            "-f", f"bv[vcodec^=avc1][height<={height}]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc1][height<={height}]/bv*[height<={height}]+ba/b",
            "--merge-output-format", "mp4"]
        sec = []
        ss, to = data.get("ss"), data.get("to")
        if ss is not None and to is not None:
            if not (isinstance(ss, (int, float)) and isinstance(to, (int, float)) and 0 <= ss < to):
                raise ValueError("Trecho inválido.")
            sec = ["--download-sections", f"*{ss}-{to}", "--force-keyframes-at-cuts"]
        stream(["yt-dlp", "--ignore-config", "--no-playlist", "--color", "never", "--newline", "--windows-filenames",
                "--progress-template", "download:PROG %(progress._percent_str)s %(progress._speed_str)s %(progress._eta_str)s",
                *fmt, *sec, "--write-info-json", "-o", str(temp / "media.%(ext)s"), "--", "https://www.youtube.com/watch?v=" + video], tick)
        if not audio and run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name",
                              "-of", "csv=p=0", str(output)]).strip() != "h264":
            fixed = temp / "h264.mp4"
            run(["ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(output), "-c:v", "libx264", "-preset", "veryfast",
                 "-pix_fmt", "yuv420p", "-c:a", "aac", str(fixed)])
            output = fixed
        title = json.loads((temp / "media.info.json").read_text(encoding="utf-8")).get("title") or video
        label = re.sub(r'[^\w .()-]', '', title)[:60].strip(' .') or video
        if sec:
            label += f" ({hms(ss)}-{hms(to)})"
    elif data["type"] == "cut":
        source_job = str(UUID(data["source"]))
        src = read(queue, "status-"+source_job+".json")
        if src.get("state") != "Pronto no Drive" or not re.fullmatch(r"[\w .()-]+\.mp4", src["name"]):
            raise ValueError("Vídeo original indisponível.")
        write(queue, job, {"state":"Preparando corte"}, temp)
        source = temp / "original.mp4"
        drive(src["dest"], "copyto", REMOTE+src["name"], source)
        clip(source, output, data["start"], data["end"])
        base = re.sub(r" \([0-9a-f-]{36}\)\.mp4$", "", src["name"])[:50]
        label = f"{base} corte {hms(data['start'])}-{hms(data['end'])}"
    else:
        raise ValueError("Tipo de pedido desconhecido.")
    name = f"{label} ({job}){output.suffix}"
    if not audio:
        write(queue, job, {"state": "Gerando prévia", "name": name}, temp)
        extra.update(make_proxy(queue, job, output, temp))
    write(queue, job, {"state": "Enviando ao Drive", "name": name}, temp)
    drive(dest, "copyto", output, REMOTE+name)
    item = json.loads(drive(dest, "lsjson", "--stat", REMOTE+name))
    write(queue, job, {"state":"Pronto no Drive","file":item["ID"],"job":job,"dest":dest,"name":name,"audio":audio,**extra}, temp)


def cycle(queue, completed):
    items = json.loads(drive(queue, "lsjson", REMOTE, "--files-only"))
    names = {item["Name"] for item in items}
    for item in sorted(items, key=lambda entry: entry["ModTime"]):
        name = item["Name"]
        match = re.fullmatch(r"job-([a-f0-9-]{36})\.json", name)
        if not match:
            continue
        job = str(UUID(match[1]))
        if job in completed:
            continue
        if "status-"+job+".json" in names and read(queue, "status-"+job+".json").get("state") in {"Pronto no Drive", "Falhou", "Cancelado"}:
            completed.add(job)
            continue
        with tempfile.TemporaryDirectory(prefix="samuka-") as folder:
            temp = Path(folder)
            try:
                if "cancel-" + job + ".json" in names:
                    raise InterruptedError("cancelado")
                process(queue, job, temp)
            except InterruptedError:
                write(queue, job, {"state": "Cancelado"}, temp)
            except Exception as exc:
                print(str(exc), flush=True)
                write(queue, job, {"state":"Falhou","error":explain(str(exc))}, temp)
            completed.add(job)


def main():
    CONFIG.mkdir(parents=True, exist_ok=True)
    config = CONFIG / "fila.txt"
    if "--setup" in sys.argv or not config.exists():
        queue = input("Cole o código da fila mostrado pelo Estúdio: ").strip()
        drive(queue, "lsjson", REMOTE, "--max-depth", "1")
        config.write_text(queue, encoding="utf-8")
    queue = config.read_text(encoding="utf-8").strip()
    for name in ["ffmpeg","ffprobe","yt-dlp","rclone","deno"]:
        if not shutil.which(name):
            raise SystemExit("Ferramenta ausente no PATH: "+name)
    import msvcrt
    with (CONFIG / "worker.lock").open("a+b") as lock:
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise SystemExit("O Estúdio já está rodando neste computador.")
        completed = set()
        for cmd in (["yt-dlp", "-U"], ["winget", "upgrade", "--id", "yt-dlp.yt-dlp", "--silent"]):
            try:
                run(cmd)
                break
            except Exception:
                pass
        threading.Thread(target=heartbeat, args=(queue,), daemon=True).start()
        print("Samuka Estúdio conectado. Deixe esta janela aberta.", flush=True)
        while True:
            try:
                cycle(queue, completed)
            except Exception as exc:
                print("Falha ao consultar o Drive:", exc, flush=True)
            time.sleep(15)


if __name__ == "__main__":
    main()

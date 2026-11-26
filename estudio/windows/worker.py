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
    output = temp / "video.mp4"
    if data["type"] == "download":
        video = data["video"]
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video):
            raise ValueError("Identificador do YouTube inválido.")
        write(queue, job, {"state":"Baixando"}, temp)
        run(["yt-dlp", "--ignore-config", "--no-playlist", "--no-progress", "--windows-filenames",
             "-f", "bv[vcodec^=avc1][height<=1080]+ba[ext=m4a]/b[ext=mp4][vcodec^=avc1]",
             "--merge-output-format", "mp4", "--write-info-json", "-o", str(output),
             "--", "https://www.youtube.com/watch?v="+video])
        title = json.loads((temp / "video.info.json").read_text(encoding="utf-8")).get("title") or video
        label = re.sub(r'[^\w .()-]', '', title)[:60].strip(' .') or video
    elif data["type"] == "cut":
        source_job = str(UUID(data["source"]))
        src = read(queue, "status-"+source_job+".json")
        if src.get("state") != "Pronto no Drive" or not re.fullmatch(r"[\w .()-]+\.mp4", src["name"]):
            raise ValueError("Vídeo original indisponível.")
        write(queue, job, {"state":"Preparando corte"}, temp)
        source = temp / "original.mp4"
        drive(src["dest"], "copyto", REMOTE+src["name"], source)
        clip(source, output, data["start"], data["end"])
        label = "Corte"
    else:
        raise ValueError("Tipo de pedido desconhecido.")
    name = f"{label} ({job}).mp4"
    write(queue, job, {"state":"Enviando ao Drive", "name":name}, temp)
    drive(dest, "copyto", output, REMOTE+name)
    item = json.loads(drive(dest, "lsjson", "--stat", REMOTE+name))
    write(queue, job, {"state":"Pronto no Drive","file":item["ID"],"job":job,"dest":dest,"name":name}, temp)


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
        if "status-"+job+".json" in names and read(queue, "status-"+job+".json").get("state") in {"Pronto no Drive", "Falhou"}:
            completed.add(job)
            continue
        with tempfile.TemporaryDirectory(prefix="samuka-") as folder:
            temp = Path(folder)
            try:
                process(queue, job, temp)
            except Exception as exc:
                print(str(exc), flush=True)
                write(queue, job, {"state":"Falhou","error":PUBLIC_ERROR}, temp)
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
        print("Samuka Estúdio conectado. Deixe esta janela aberta.", flush=True)
        while True:
            try:
                cycle(queue, completed)
            except Exception as exc:
                print("Falha ao consultar o Drive:", exc, flush=True)
            time.sleep(15)


if __name__ == "__main__":
    main()

import sys
import json
import asyncio
import base64
import os

# Try importing winrt, fallback to winsdk
try:
    import winrt.windows.media.control as wmc
    import winrt.windows.storage.streams as wss
    import winrt.system as system
except ImportError:
    try:
        import winsdk.windows.media.control as wmc
        import winsdk.windows.storage.streams as wss
        import winsdk.system as system
    except ImportError:
        print(json.dumps({"status": "error", "message": "Neither winrt nor winsdk package is installed."}))
        sys.exit(1)

async def get_thumbnail(session, last_title, last_artist, title, artist):
    if not session:
        return ""
    try:
        media_props = await session.try_get_media_properties_async()
        if not media_props or not media_props.thumbnail:
            return ""
        
        # Check cache
        if title == last_title and artist == last_artist:
            return "USE_CACHE"
            
        stream = await media_props.thumbnail.open_read_async()
        size = stream.size
        if size == 0:
            return ""
            
        buffer = wss.Buffer(size)
        await stream.read_async(buffer, size, wss.InputStreamOptions.NONE)
        data = system.get_buffer_data(buffer)
        return base64.b64encode(data).decode('utf-8')
    except Exception as e:
        return ""

async def main():
    last_title = os.environ.get("LAST_TITLE", "")
    last_artist = os.environ.get("LAST_ARTIST", "")
    
    try:
        manager = await wmc.GlobalSystemMediaTransportControlsSessionManager.request_async()
        session = manager.get_current_session()
        if not session:
            print(json.dumps({"status": "no_session"}))
            return
            
        media_props = await session.try_get_media_properties_async()
        timeline_props = session.get_timeline_properties()
        playback_info = session.get_playback_info()
        
        title = media_props.title if media_props else ""
        artist = media_props.artist if media_props else ""
        album = media_props.album_title if media_props else ""
        
        thumbnail = await get_thumbnail(session, last_title, last_artist, title, artist)
        
        is_playing = False
        shuffle_active = False
        repeat_mode = 0
        can_play = True
        can_pause = True
        can_next = False
        can_prev = False
        can_shuffle = False
        can_repeat = False
        can_seek = False
        
        if playback_info:
            # Playback status: Closed=0, Opened=1, Changing=2, Stopped=3, Playing=4, Paused=5
            is_playing = (playback_info.playback_status == 4)
            controls = playback_info.controls
            if controls:
                can_play = controls.is_play_enabled
                can_pause = controls.is_pause_enabled
                can_next = controls.is_next_enabled
                can_prev = controls.is_previous_enabled
                can_shuffle = controls.is_shuffle_enabled
                can_repeat = controls.is_repeat_enabled
                can_seek = controls.is_playback_position_enabled
                
            shuffle_active = bool(playback_info.is_shuffle_active)
            rm = playback_info.auto_repeat_mode
            # AutoRepeatMode: None = 0, Track = 1, List = 2
            if rm == 1:
                repeat_mode = 2 # track
            elif rm == 2:
                repeat_mode = 1 # list
            else:
                repeat_mode = 0
                
        position = 0
        duration = 0
        if timeline_props:
            position = timeline_props.position.total_seconds()
            duration = timeline_props.end_time.total_seconds()
            
        result = {
            "status": "ok",
            "title": title,
            "artist": artist,
            "album": album,
            "thumbnail": thumbnail,
            "isPlaying": is_playing,
            "position": round(position, 2),
            "duration": round(duration, 2),
            "shuffleActive": shuffle_active,
            "repeatMode": repeat_mode,
            "capabilities": {
                "canPlay": can_play,
                "canPause": can_pause,
                "canNext": can_next,
                "canPrev": can_prev,
                "canShuffle": can_shuffle,
                "canRepeat": can_repeat,
                "canSeek": can_seek
            }
        }
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))

if __name__ == "__main__":
    asyncio.run(main())

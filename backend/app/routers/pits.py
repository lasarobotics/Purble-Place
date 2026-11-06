import json
import httpx
from fastapi import APIRouter, Depends, HTTPException
from .. import repo
from ..auth import current_scouter, require_admin
from ..pits import SheetConfig, import_sheet

router = APIRouter(prefix='/api', tags=['pits'])

@router.get('/pits')
def board(_=Depends(current_scouter)):
    return json.loads(repo.setting('pits_board') or '{"rotations":[],"matches":[],"updated_at":null}')

@router.get('/admin/pits-sheet')
def config(_=Depends(require_admin)):
    return json.loads(repo.setting('pits_sheet') or SheetConfig(url='').model_dump_json())

@router.post('/admin/pits-sheet')
async def update(config: SheetConfig, _=Depends(require_admin)):
    try:
        result = await import_sheet(config)
    except (ValueError, httpx.HTTPError) as error:
        raise HTTPException(400, str(error) or 'Sheet request failed. Try again.') from error
    # Publish only after both tabs pass validation; failed imports keep the last board.
    repo.set_setting('pits_board', json.dumps(result))
    repo.set_setting('pits_sheet', config.model_dump_json())
    return result

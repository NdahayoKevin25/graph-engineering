import { ENV } from './env';
export class ApiError extends Error { constructor(message:string,public readonly status:number){super(message);this.name='ApiError';} }
export interface ApiSuccess<T>{message:string;data:T}
export interface PaginationMeta{page:number;pageSize:number;total:number;totalPages:number}
export interface ApiPaginated<T>{message:string;data:T[];pagination:PaginationMeta}
export interface ApiOptions{method?:'GET'|'POST'|'PUT'|'PATCH'|'DELETE';body?:string;signal?:AbortSignal}
export function apiUrl(path:string):string {
  if(typeof path!=='string'||path.length>4096||/[\\#\u0000-\u0020\u007f]/.test(path)||!/^\/api\/[A-Za-z0-9_/-]+(?:\?[^#]*)?$/.test(path))throw new ApiError('Invalid API path',400);
  const target=new URL(path,ENV.API_URL);
  if(target.origin!==ENV.API_URL||!target.pathname.startsWith('/api/')||target.pathname.includes('//')||target.pathname.split('/').some(part=>part==='.'||part==='..'))throw new ApiError('Invalid API path',400);
  return target.href;
}
export async function apiFetch<T>(path:string,options:ApiOptions={}):Promise<T>{
  const target=apiUrl(path),method=options.method??'GET';
  if(!['GET','POST','PUT','PATCH','DELETE'].includes(method)||Object.keys(options).some(key=>!['method','body','signal'].includes(key))||
    (options.body!==undefined&&(typeof options.body!=='string'||new TextEncoder().encode(options.body).length>65536||method==='GET')))throw new ApiError('Invalid API request',400);
  if(options.body!==undefined){try{JSON.parse(options.body);}catch{throw new ApiError('Invalid JSON request',400);}}
  const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);
  try {
    const response=await fetch(target,{method,body:options.body,signal,credentials:'include',redirect:'error',cache:'no-store',headers:{Accept:'application/json',...(options.body===undefined?{}:{'Content-Type':'application/json'})}});
    if(!response.ok){await response.body?.cancel();throw new ApiError(response.status===401?'Authentication required':response.status===403?'Access denied':response.status===429?'Too many requests':'Request failed',response.status);}
    if(response.status===204)return undefined as T;
    if(response.headers.get('content-type')?.split(';',1)[0]?.trim().toLowerCase()!=='application/json'){await response.body?.cancel();throw new ApiError('Invalid API response',502);}
    const declared=response.headers.get('content-length');
    if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>1048576)){await response.body?.cancel();throw new ApiError('API response exceeds limit',502);}
    const reader=response.body?.getReader();if(!reader)throw new ApiError('Invalid API response',502);
    const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const result=await reader.read();if(result.done)break;size+=result.value.byteLength;if(size>1048576||chunks.length>=2048)throw new ApiError('API response exceeds limit',502);chunks.push(result.value);}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as T;}catch{throw new ApiError('Invalid API response',502);}
  }catch(error){if(error instanceof ApiError)throw error;throw new ApiError(signal.aborted?'Request cancelled or timed out':'Network request failed',0);}
}

'use client';
import type {ReactNode} from 'react';
import {useAuth,type AuthUser} from '../lib/auth/AuthContext';
import {useFormState} from '../lib/forms/useFormState';
import {useQueryTable} from '../lib/tables/useQueryTable';
import {DataTable,type Column} from './DataTable';

export interface DashboardNavItem {
  href:string;
  label:string;
  roles:readonly AuthUser['role'][];
}
export interface DashboardStat {label:string;value:string|number}
export interface DashboardTable<T> {
  heading:string;
  basePath:string;
  columns:Column<T>[];
  getRowId:(row:T)=>string;
}
export interface DashboardProps<T> {
  title:string;
  navigation?:readonly DashboardNavItem[];
  stats?:readonly DashboardStat[];
  table?:DashboardTable<T>;
  onSaveProfile?:(values:Readonly<{firstName:string;lastName:string}>)=>Promise<void>;
  children?:ReactNode;
}

function validPath(value:string):boolean {
  return typeof value==='string'&&value.length<=256&&/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?\/?$/.test(value);
}
function ProfileForm({user,onSave}:{user:AuthUser;onSave:NonNullable<DashboardProps<unknown>['onSaveProfile']>}) {
  const form=useFormState({firstName:user.firstName,lastName:user.lastName});
  return <section aria-label="Profile settings"><h2>Profile</h2><form onSubmit={form.handleSubmit(onSave)}>
    <label>First name<input name="firstName" value={form.values.firstName} onChange={form.handleChange('firstName')} required maxLength={100}/></label>
    <label>Last name<input name="lastName" value={form.values.lastName} onChange={form.handleChange('lastName')} required maxLength={100}/></label>
    <button type="submit" disabled={form.isSubmitting}>Save profile</button>
    {form.formError&&<p role="alert">{form.formError}</p>}
  </form></section>;
}
function AuthorizedTable<T extends object>({table}:{table:DashboardTable<T>}) {
  const state=useQueryTable<T>(table.basePath);
  return <section aria-label="Dashboard table"><h2>{table.heading}</h2><DataTable table={state} columns={table.columns} getRowId={table.getRowId}/></section>;
}

/** Display composition only. Server-side authentication, row scope and authorization remain mandatory. */
export function Dashboard<T extends object=Record<string,unknown>>({title,navigation=[],stats=[],table,onSaveProfile,children}:DashboardProps<T>) {
  const {user,isLoading,error}=useAuth();
  if(typeof title!=='string'||title.length<1||title.length>100||!Array.isArray(navigation)||navigation.length>24||navigation.some(item=>!item||!validPath(item.href)||typeof item.label!=='string'||item.label.length<1||item.label.length>100||!Array.isArray(item.roles)||item.roles.length<1||item.roles.some((role:AuthUser['role'])=>role!=='customer'&&role!=='admin')))
    throw new Error('Invalid dashboard navigation');
  if(!Array.isArray(stats)||stats.length>12||stats.some(item=>!item||typeof item.label!=='string'||item.label.length<1||item.label.length>100||(typeof item.value!=='string'&&typeof item.value!=='number')||(typeof item.value==='string'&&item.value.length>100)||(typeof item.value==='number'&&!Number.isFinite(item.value))))
    throw new Error('Invalid dashboard statistics');
  if(table&&(typeof table.heading!=='string'||table.heading.length<1||table.heading.length>100))throw new Error('Invalid dashboard table');
  if(isLoading)return <main aria-busy="true"><p role="status">Checking session…</p></main>;
  if(!user)return <main><h1>{title}</h1>{error&&<p role="alert">{error}</p>}<p>Sign in to view this dashboard.</p><a href="/login">Sign in</a></main>;
  return <main><header><h1>{title}</h1><p>Welcome, {user.firstName}.</p>
    {navigation.length>0&&<nav aria-label="Dashboard navigation">{navigation.filter(item=>item.roles.includes(user.role)).map(item=><a key={item.href} href={item.href}>{item.label}</a>)}</nav>}
  </header>
  {stats.length>0&&<section aria-label="Dashboard statistics"><h2>Overview</h2><dl>{stats.map((item,index)=><div key={`${index}:${item.label}`}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl></section>}
  {table&&<AuthorizedTable table={table}/>}
  {onSaveProfile&&<ProfileForm key={`${user.id}:${user.firstName}:${user.lastName}`} user={user} onSave={onSaveProfile}/>}
  {children}
  </main>;
}

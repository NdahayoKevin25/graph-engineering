import {beforeEach,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import type {AuthUser} from '../lib/auth/AuthContext';
import {Dashboard} from '../components/Dashboard';

const state=vi.hoisted(()=>({user:null as AuthUser|null,loading:false,tablePaths:[] as string[]}));
vi.mock('../lib/auth/AuthContext',()=>({useAuth:()=>({user:state.user,isLoading:state.loading,error:null})}));
vi.mock('../lib/tables/useQueryTable',()=>({useQueryTable:(path:string)=>{
  state.tablePaths.push(path);
  return {rows:[{id:'item-1',name:'Item A'}],meta:{page:1,pageSize:20,total:1,totalPages:1},page:1,setPage:()=>{},sortBy:undefined,sortDir:'asc',setSort:()=>{},filters:{},setFilter:()=>{},isLoading:false,error:null,refetch:()=>{}};
}}));
const table={heading:'Items',basePath:'/api/items',columns:[{key:'name' as const,label:'Name'}],getRowId:(row:{id:string;name:string})=>row.id};
const navigation=[{href:'/dashboard',label:'Overview',roles:['customer','admin'] as const},{href:'/dashboard/admin',label:'Admin',roles:['admin'] as const}];
beforeEach(()=>{state.user=null;state.loading=false;state.tablePaths.length=0;});

it('does not mount a table hook while authentication is still loading',()=>{
  state.loading=true;
  render(<Dashboard title="Workspace" table={table} navigation={navigation}/>);
  expect(screen.getByRole('status')).toHaveTextContent('Checking session');
  expect(state.tablePaths).toEqual([]);
});

it('does not fetch table data or show protected display when signed out',()=>{
  render(<Dashboard title="Workspace" table={table} navigation={navigation} stats={[{label:'Revenue',value:'private'}]}/>);
  expect(state.tablePaths).toEqual([]);
  expect(screen.getByRole('link',{name:'Sign in'})).toHaveAttribute('href','/login');
  expect(screen.queryByText('private')).toBeNull();
});
it('renders role-gated navigation and composes table, stats and profile form',async()=>{
  state.user={id:'user-1',email:'ada@example.invalid',role:'admin',status:'active',emailVerifiedAt:null,firstName:'Ada',lastName:'Example'};
  const onSave=vi.fn(async(_values:Readonly<{firstName:string;lastName:string}>)=>{});
  render(<Dashboard title="Workspace" table={table} navigation={navigation} stats={[{label:'Active items',value:1}]} onSaveProfile={onSave}/>);
  expect(state.tablePaths).toEqual(['/api/items']);
  expect(screen.getByRole('link',{name:'Admin'})).toHaveAttribute('href','/dashboard/admin');
  expect(screen.getByText('Item A')).toBeInTheDocument();
  expect(screen.getByText('Active items')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox',{name:'First name'}),{target:{value:'Ada II'}});
  fireEvent.click(screen.getByRole('button',{name:'Save profile'}));
  await waitFor(()=>expect(onSave).toHaveBeenCalledWith({firstName:'Ada II',lastName:'Example'}));
});
it('hides admin navigation for a customer and rejects off-site navigation',()=>{
  state.user={id:'user-2',email:'customer@example.invalid',role:'customer',status:'active',emailVerifiedAt:null,firstName:'Customer',lastName:'Example'};
  render(<Dashboard title="Workspace" navigation={navigation}/>);
  expect(screen.queryByRole('link',{name:'Admin'})).toBeNull();
  expect(()=>render(<Dashboard title="Workspace" navigation={[{href:'https://example.invalid',label:'Bad',roles:['admin']}]}/>)).toThrow('Invalid dashboard navigation');
});

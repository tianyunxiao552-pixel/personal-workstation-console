import { createContext,useContext,useState,useEffect,useMemo,forwardRef,type PropsWithChildren,type InputHTMLAttributes,type TextareaHTMLAttributes } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from '@phosphor-icons/react';
const Environment=createContext({height:800,width:400,focused:false});
export function NativeSurface({children}:PropsWithChildren){
  const [env,setEnv]=useState(()=>({height:window.visualViewport?.height||window.innerHeight,width:window.innerWidth,focused:false}));
  useEffect(()=>{const update=()=>{const el=document.activeElement;setEnv({height:window.visualViewport?.height||window.innerHeight,width:window.innerWidth,focused:!!el&&['INPUT','TEXTAREA'].includes(el.tagName)});};window.visualViewport?.addEventListener('resize',update);window.addEventListener('resize',update);document.addEventListener('focusin',update);document.addEventListener('focusout',update);return()=>{window.visualViewport?.removeEventListener('resize',update);window.removeEventListener('resize',update);document.removeEventListener('focusin',update);document.removeEventListener('focusout',update);};},[]);
  return <Environment.Provider value={env}><div className="native-host" style={{height:env.height}}>{children}</div></Environment.Provider>;
}
const noop=()=>{};
export function useMobileDevice(){const env=useContext(Environment);return useMemo(()=>({device:{id:'pixel-10',label:'Android',platform:'android',geometry:{screen:{width:env.width,height:env.height},safeArea:{top:0,bottom:0}}},deviceId:'pixel-10',setDeviceId:noop}),[env.width,env.height]);}
export function useKeyboard(){return useMemo(()=>({hide:()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();},show:noop}),[]);}
export function useKeyboardInsets(){const env=useContext(Environment);return{bottomInset:0,isKeyboardVisible:env.focused,keyboardHeight:0};}
export function MobileScroll({children,className=''}:PropsWithChildren<{className?:string}>){return <div className={`native-scroll ${className}`}>{children}</div>;}
export const KeyboardInput=forwardRef<HTMLInputElement,InputHTMLAttributes<HTMLInputElement>>((props,ref)=><input {...props} ref={ref}/>);
export function KeyboardTextarea(props:TextareaHTMLAttributes<HTMLTextAreaElement>){return <textarea {...props}/>;}
export function Carousel({children,className='',contentClassName='',ariaLabel}:PropsWithChildren<{className?:string;contentClassName?:string;ariaLabel?:string}>){return <div className={`native-carousel ${className}`} aria-label={ariaLabel}><div className={contentClassName}>{children}</div></div>;}
export function BottomSheet({children,open,onOpenChange,title,description,snap=.82}:PropsWithChildren<{open:boolean;onOpenChange:(v:boolean)=>void;title:string;description?:string;snap?:number}>){const env=useContext(Environment);return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="native-overlay"/><Dialog.Content className="native-sheet" style={{maxHeight:Math.max(260,env.height*snap)}}><div className="native-sheet-head"><Dialog.Title>{title}</Dialog.Title><Dialog.Close aria-label="关闭"><X size={20}/></Dialog.Close>{description&&<Dialog.Description>{description}</Dialog.Description>}</div><div className="native-sheet-body">{children}</div></Dialog.Content></Dialog.Portal></Dialog.Root>;}

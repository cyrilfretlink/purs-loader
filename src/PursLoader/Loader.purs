module PursLoader.Loader
  ( Effects()
  , Effects_()
  , loader
  , loaderFn
  ) where

import Prelude (Unit(), ($), (>>=), (<$>), (<*>), (++), (<<<), bind, const, id, pure, unit, void)

import Control.Bind (join)
import Control.Monad.Eff (Eff(), foreachE)
import Control.Monad.Eff.Console (CONSOLE())
import Control.Monad.Eff.Exception (EXCEPTION(), Error(), error, message)

import Data.Array ((!!))
import Data.Either (Either(..), either)
import Data.Function (Fn2(), mkFn2)
import Data.Maybe (maybe)
import Data.Nullable (toMaybe)
import Data.String.Regex (Regex(), match, noFlags, regex)

import Node.Encoding (Encoding(UTF8))
import Node.Process (stderr)
import Node.Stream (writeString)

import Unsafe.Coerce (unsafeCoerce)

import PursLoader.LoaderRef
  ( AsyncCallback()
  , LoaderRef()
  , Loader()
  , async
  , cacheable
  , addDependency
  , resourcePath
  )

import PursLoader.Debug (debug)
import PursLoader.Path (dirname, joinPath, relative)
import PursLoader.Plugin as Plugin

type Effects eff = (console :: CONSOLE, err :: EXCEPTION | eff)

type Effects_ eff = Effects (loader :: Loader | eff)

loader :: forall eff. LoaderRef -> String -> Eff (Effects_ eff) Unit
loader ref source = do
  callback <- async ref

  cacheable ref

  debug "Invoke PureScript plugin compilation"

  pluginContext.compile (compile callback)
  where
  pluginContext :: Plugin.Context (Effects_ eff)
  pluginContext = (unsafeCoerce ref).purescriptWebpackPluginContext

  compile :: AsyncCallback (Effects eff) -> Plugin.Compile (Effects_ eff)
  compile callback error' graph output = do
    either (const $ pure unit) (\a -> debug ("Adding PureScript dependency " ++ a)) name

    addDependency ref (resourcePath ref)

    void $ writeString stderr UTF8 output (pure unit)

    maybe (pure unit) (\a -> void $ writeString stderr UTF8 (message a) (pure unit)) (toMaybe error')

    either (const $ callback (pure fixedError) "") id
           (handle <$> name <*> dependencies <*> exports)
    where
    fixedError :: Error
    fixedError = error "PureScript compilation has failed."

    handle :: String -> Array String -> String -> Eff (Effects_ eff) Unit
    handle name' deps res = do
      debug ("Adding PureScript dependencies for " ++ name')
      foreachE deps (addDependency ref)
      debug "Generated loader result"
      debug res
      callback (const fixedError <$> toMaybe error') res

    exports :: Either Error String
    exports =
      if pluginContext.options.bundle
         then bundleExport <$> name
         else moduleExport <<< modulePath <$> name
      where
      bundleExport :: String -> String
      bundleExport name' = "module.exports = require('" ++ path ++ "')['" ++ name' ++ "'];"
        where
        path :: String
        path = relative resourceDir pluginContext.options.bundleOutput

      moduleExport :: String -> String
      moduleExport path = "module.exports = require('" ++ path ++ "');"

      modulePath :: String -> String
      modulePath = relative resourceDir <<< joinPath pluginContext.options.output

      resourceDir :: String
      resourceDir = dirname (resourcePath ref)

    dependencies :: Either Error (Array String)
    dependencies = Plugin.dependenciesOf graph (resourcePath ref)

    name :: Either Error String
    name =
      maybe (Left $ error "Failed to parse module name") Right
            (join $ match re source >>= \as -> as !! 1)
      where
      re :: Regex
      re = regex "(?:^|\\n)module\\s+([\\w\\.]+)" noFlags { ignoreCase = true }

loaderFn :: forall eff. Fn2 LoaderRef String (Eff (Effects_ eff) Unit)
loaderFn = mkFn2 loader